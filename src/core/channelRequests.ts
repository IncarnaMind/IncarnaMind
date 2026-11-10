/**
 * The requests out on a model's channels (the embedding and reranking processes), each kept with
 * the channel it was sent on (#2930). A channel that is stopped or exits fails what it still owes,
 * and only that: no request waits for ever, and an older channel's exit never fails a newer one's.
 */

/** A request failed because its channel was closed on purpose, not because the model failed. */
export class ChannelClosedError extends Error {
  override name = "ChannelClosedError";
}

export function channelRequests<Channel, Response>() {
  const waiting = new Map<
    number,
    { on: Channel; resolve(response: Response): void; reject(error: Error): void }
  >();
  let nextId = 1;
  return {
    /** Sends a request on `channel` with a new id: resolves with its answer, or rejects with `rejectAll`. */
    add(channel: Channel, send: (id: number) => void): Promise<Response> {
      const id = nextId++;
      return new Promise<Response>((resolve, reject) => {
        waiting.set(id, { on: channel, resolve, reject });
        try {
          send(id);
        } catch (error) {
          waiting.delete(id);
          throw error;
        }
      });
    },

    answer(id: number, response: Response): void {
      const request = waiting.get(id);
      waiting.delete(id);
      request?.resolve(response);
    },

    rejectAll(channel: Channel, error: Error): void {
      for (const [id, request] of waiting) {
        if (request.on !== channel) continue;
        waiting.delete(id);
        request.reject(error);
      }
    },

    /** The ids of the requests still out on `channel`. */
    out(channel: Channel): number[] {
      return [...waiting].flatMap(([id, request]) => (request.on === channel ? [id] : []));
    },
  };
}
