/**
 * What this window still has on its way in a Note, and whether a change the Note holds is one of
 * them (#1325): an Answer asked here applies its changes as they arrive, so the card's count of
 * what waits in the Note leaves them out while its Answer is still being answered or applied, and
 * counts them again once it settles — or never applies them, as after a restart or when the apply
 * finds the text changed.
 */
import type * as Y from "yjs";
import type { ConversationMessage } from "../../core/api";
import { askedFor } from "../../shared/askedChanges";
import { changedMinds } from "./changedMinds";

/** What this window still has on its way in one Note. */
export interface ArrivingInMind {
  /** The requests of the Answers this window is still answering, or applying the changes of. */
  requests: ReadonlySet<string>;
  /** Every request the thread names in this Note, so one no Answer names yet can be told apart. */
  known: ReadonlySet<string>;
  /** Some Answer in this window still has changes on their way: a request no Answer names yet may be one of them. */
  open: boolean;
}

export function arrivingInMind(
  messages: readonly ConversationMessage[],
  mindId: string,
  arrivingAnswers: ReadonlySet<string>,
): ArrivingInMind {
  const requests = new Set<string>();
  const known = new Set<string>();
  for (const message of messages) {
    if (message.kind !== "answer") continue;
    for (const row of changedMinds(message)) {
      if (row.mindId !== mindId) continue;
      for (const request of row.requests) {
        known.add(request);
        if (arrivingAnswers.has(message.id)) requests.add(request);
      }
    }
  }
  return { requests, known, open: arrivingAnswers.size > 0 };
}

/**
 * Whether this window is applying a request's changes at once. Not because the Note records it as
 * asked: an Answer stopped mid-write, or an apply that found the text changed, leaves its asked
 * changes waiting, and they must still count (#1325).
 */
export function arrivingNow(
  doc: Y.Doc,
  request: string,
  arriving: ArrivingInMind | undefined,
): boolean {
  if (!arriving || !askedFor(doc, request)) return false;
  return arriving.requests.has(request) || (arriving.open && !arriving.known.has(request));
}
