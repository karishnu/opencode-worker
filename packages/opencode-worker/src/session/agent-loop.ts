import { streamText, convertToModelMessages, tool, jsonSchema, type UIMessage } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { StoredMessage, SessionEvent, ToolCallInfo, ToolResultInfo } from "../types"

const MAX_TOOL_ROUNDS = 25

export interface AgentLoopInput {
  model: LanguageModelV3
  tools: Record<string, any>
  getMessages: () => StoredMessage[]
  sessionId: string
  signal: AbortSignal
  onEvent: (event: SessionEvent) => Promise<void>
}

/**
 * Convert StoredMessage[] → UIMessage[] for use with convertToModelMessages.
 * Mirrors upstream opencode's toModelMessagesEffect (message-v2.ts).
 */
function toUIMessages(stored: StoredMessage[]): UIMessage[] {
  const result: UIMessage[] = []

  for (const msg of stored) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const parts = msg.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => ({ type: "text" as const, text: p.text! }))
      if (parts.length > 0) {
        result.push({ id: msg.info.id, role: "user", parts })
      }
      continue
    }

    if (msg.info.role === "assistant") {
      // Skip errored assistant messages (upstream pattern)
      if (msg.info.error) continue

      const parts: UIMessage["parts"] = []
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          parts.push({ type: "text" as const, text: part.text })
        }
        if (part.type === "step-start") {
          parts.push({ type: "step-start" as const })
        }
        if (part.type === "reasoning" && part.text) {
          parts.push({ type: "reasoning" as const, text: part.text })
        }
        if (part.type === "tool" && part.tool && part.callID) {
          const name = part.tool
          if (part.state?.status === "completed") {
            parts.push({
              type: `tool-${name}` as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output: part.state.output ?? "",
            } as any)
          } else if (part.state?.status === "error") {
            parts.push({
              type: `tool-${name}` as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state?.input ?? {},
              errorText: part.state.error ?? "Tool execution failed",
            } as any)
          } else {
            // pending/running → treat as interrupted (upstream pattern)
            parts.push({
              type: `tool-${name}` as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state?.input ?? {},
              errorText: "[Tool execution was interrupted]",
            } as any)
          }
        }
      }

      if (parts.length > 0) {
        result.push({ id: msg.info.id, role: "assistant", parts })
      }
    }
  }

  return result
}

/**
 * Run the agent loop: send messages to the LLM, execute tool calls,
 * stream partial text, and repeat until the model returns a final
 * text response or we hit the tool round limit.
 *
 * Uses convertToModelMessages (from AI SDK) and experimental_repairToolCall
 * (from upstream opencode) to properly handle tool-call/tool-result pairing
 * and avoid MissingToolResultsError.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<void> {
  const { model, tools, getMessages, sessionId, signal, onEvent } = input

  // Add invalid tool for experimental_repairToolCall (from upstream llm.ts)
  const allTools: Record<string, any> = {
    ...tools,
    invalid: tool({
      description: "Called when the model makes an invalid tool call. Do not call this tool directly.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          tool: { type: "string", description: "The invalid tool name" },
          error: { type: "string", description: "The error message" },
        },
      }),
      execute: async (args: any) =>
        `Error: Invalid tool call "${args.tool}": ${args.error}`,
    }),
  }

  // Build initial UIMessages from stored history
  const uiMessages: UIMessage[] = toUIMessages(getMessages())
  let round = 0

  while (round < MAX_TOOL_ROUNDS) {
    if (signal.aborted) break

    // Convert UIMessages → ModelMessages via AI SDK (handles tool-call/result pairing)
    const messages = await convertToModelMessages(uiMessages, { tools: allTools })

    const result = streamText({
      model,
      tools: allTools,
      messages,
      abortSignal: signal,
      activeTools: Object.keys(allTools).filter((x) => x !== "invalid"),
      onError(error) {
        console.error("[agent-loop] streamText error:", error)
      },
      // From upstream llm.ts — repairs invalid tool calls instead of crashing
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && allTools[lower]) {
          console.log(`[agent-loop] repairing tool call: ${failed.toolCall.toolName} → ${lower}`)
          return { ...failed.toolCall, toolName: lower }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
    })

    let fullText = ""
    const msgId = crypto.randomUUID()
    const toolCalls: ToolCallInfo[] = []
    const toolResults: ToolResultInfo[] = []

    for await (const part of result.fullStream) {
      if (signal.aborted) break

      switch (part.type) {
        case "text-start": {
          await onEvent({ type: "text.start", sessionId, messageId: msgId })
          break
        }
        case "text-delta": {
          fullText += part.text
          await onEvent({
            type: "message.delta",
            sessionId,
            messageId: msgId,
            delta: part.text,
          })
          break
        }
        case "text-end": {
          await onEvent({ type: "text.end", sessionId, messageId: msgId })
          break
        }
        case "reasoning-delta": {
          await onEvent({
            type: "reasoning.delta",
            sessionId,
            messageId: msgId,
            delta: (part as any).text || "",
          } as any)
          break
        }
        case "tool-call": {
          const tc: ToolCallInfo = {
            id: part.toolCallId,
            name: part.toolName,
            arguments: part.input as Record<string, unknown>,
          }
          toolCalls.push(tc)
          await onEvent({
            type: "tool.called",
            sessionId,
            messageId: msgId,
            tool: tc,
          })
          break
        }
        case "tool-result": {
          const output = (part as any).output
          const tr: ToolResultInfo = {
            callId: part.toolCallId,
            name: part.toolName,
            result: typeof output === "string" ? output : JSON.stringify(output),
          }
          toolResults.push(tr)
          await onEvent({
            type: "tool.result",
            sessionId,
            messageId: msgId,
            result: tr,
          })
          break
        }
        case "tool-error": {
          const err = (part as any).error
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[agent-loop] tool-error ${part.toolName}(${part.toolCallId}):`, msg)
          const tr: ToolResultInfo = {
            callId: part.toolCallId,
            name: part.toolName,
            result: `Error: ${msg}`,
            isError: true,
          }
          toolResults.push(tr)
          await onEvent({
            type: "tool.result",
            sessionId,
            messageId: msgId,
            result: tr,
          })
          break
        }
        case "error": {
          console.error("[agent-loop] stream error:", (part as any).error)
          break
        }
      }
    }

    await onEvent({
      type: "message.completed",
      sessionId,
      messageId: msgId,
    })

    // No tool calls → done
    if (toolCalls.length === 0) break

    // Build UIMessage for this round's assistant response.
    // convertToModelMessages handles tool-call/result pairing on the next iteration.
    const resultMap = new Map(toolResults.map((tr) => [tr.callId, tr]))
    const uiParts: UIMessage["parts"] = []

    if (fullText) {
      uiParts.push({ type: "text" as const, text: fullText })
    }

    for (const tc of toolCalls) {
      const tr = resultMap.get(tc.id)
      if (tr?.isError) {
        uiParts.push({
          type: `tool-${tc.name}` as `tool-${string}`,
          state: "output-error",
          toolCallId: tc.id,
          input: tc.arguments,
          errorText: tr.result,
        } as any)
      } else if (tr) {
        uiParts.push({
          type: `tool-${tc.name}` as `tool-${string}`,
          state: "output-available",
          toolCallId: tc.id,
          input: tc.arguments,
          output: tr.result,
        } as any)
      } else {
        // No result — mark as interrupted (upstream pattern)
        uiParts.push({
          type: `tool-${tc.name}` as `tool-${string}`,
          state: "output-error",
          toolCallId: tc.id,
          input: tc.arguments,
          errorText: "[Tool execution was interrupted]",
        } as any)
      }
    }

    uiMessages.push({ id: msgId, role: "assistant", parts: uiParts })
    round++
  }
}
