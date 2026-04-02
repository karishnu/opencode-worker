/**
 * In-memory event bus for broadcasting events to SSE subscribers.
 *
 * Mirrors the upstream OpenCode bus pattern where all state changes
 * are published to a single event stream that clients subscribe to.
 */

import type { BusEventPayload } from "./upstream-types"

type Listener = (event: BusEventPayload) => void

const listeners = new Set<Listener>()

export const Bus = {
  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  /** Publish an event to all subscribers. */
  publish(event: BusEventPayload): void {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch {
        // ignore listener errors
      }
    }
  },
}
