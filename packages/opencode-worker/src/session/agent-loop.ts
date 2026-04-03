import { streamText, type ModelMessage } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { SessionMessage, SessionEvent, ToolCallInfo, ToolResultInfo } from "../types"

const MAX_TOOL_ROUNDS = 25

export interface AgentLoopInput {
  model: LanguageModelV3
  tools: Record<string, any>
  history: SessionMessage[]
  sessionId: string
  signal: AbortSignal
  onEvent: (event: SessionEvent) => Promise<void>
  appendMessage: (msg: Omit<SessionMessage, "sessionId">) => Promise<SessionMessage>
}

/**
 * Run the agent loop: send messages to the LLM, execute tool calls,
 * stream partial text, and repeat until the model returns a final
 * text response or we hit the tool round limit.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<void> {
  const { model, tools, history, sessionId, signal, onEvent, appendMessage } = input

  // Convert stored messages to AI SDK ModelMessage format
  const messages: ModelMessage[] = history.map((m) => {
    if (m.role === "user") {
      return { role: "user" as const, content: [{ type: "text" as const, text: m.content }] }
    }
    if (m.role === "system") {
      return { role: "system" as const, content: m.content }
    }
    // assistant and tool roles
    return { role: "assistant" as const, content: [{ type: "text" as const, text: m.content }] }
  })

  let toolRounds = 0

  while (toolRounds < MAX_TOOL_ROUNDS) {
    if (signal.aborted) break

    const result = streamText({
      model,
      tools,
      messages,
      abortSignal: signal,
    })

    let fullText = ""
    const assistantMsgId = crypto.randomUUID()
    const toolCalls: ToolCallInfo[] = []
    const toolResults: ToolResultInfo[] = []

    // Stream text deltas
    for await (const part of result.fullStream) {
      if (signal.aborted) break

      switch (part.type) {
        case "text-delta": {
          fullText += part.text
          await onEvent({
            type: "message.delta",
            sessionId,
            messageId: assistantMsgId,
            delta: part.text,
          })
          break
        }
        case "reasoning-delta": {
          await onEvent({
            type: "reasoning.delta",
            sessionId,
            messageId: assistantMsgId,
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
            messageId: assistantMsgId,
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
            messageId: assistantMsgId,
            result: tr,
          })
          break
        }
      }
    }

    // Store assistant message
    await appendMessage({
      id: assistantMsgId,
      role: "assistant",
      content: fullText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      createdAt: Date.now(),
    })

    await onEvent({
      type: "message.completed",
      sessionId,
      messageId: assistantMsgId,
    })

    // If no tool calls were made, we're done
    if (toolCalls.length === 0) {
      break
    }

    // Add assistant message with tool calls and results to conversation
    messages.push({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: fullText }],
    })

    // Add tool results for the next round
    for (const tr of toolResults) {
      messages.push({
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: tr.callId,
            toolName: tr.name,
            output: { type: "text" as const, value: tr.result },
          },
        ],
      })
    }

    toolRounds++
  }
}
