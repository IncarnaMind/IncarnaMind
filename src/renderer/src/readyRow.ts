/**
 * What the first-open card's Ask row shows, from what the card knows: which of its lines it
 * draws, and whether its Question can be pressed. Pure, so every state it can be in — including
 * one the built app reaches only for a moment — is a case a test can name.
 */

/** What the row is saying. */
export type ReadyRow =
  /** The ready Question is being asked and its Answer waits for `document` to be read. */
  | { kind: "waiting"; document: string }
  /** The ready Question, and whether it can be pressed now. */
  | { kind: "question"; disabled: boolean }
  /** The User's own Document still being read, before there is a Question about it. */
  | { kind: "reading"; document: string }
  /** Files in what the row would ask about couldn't be read. */
  | { kind: "unread"; count: number }
  /** No Question yet: press ⌘J and ask one's own. */
  | { kind: "own" };

export function readyRowOf({
  question,
  waitingFor,
  asking,
  pressedFor,
  reading,
  unread,
  busy,
}: {
  /** The ready Question's words; null while there is none. */
  question: string | null;
  /** The Document the Answer waits for, as the core says now. */
  waitingFor: string | null;
  /** That Question is being asked, and its Answer isn't there yet. */
  asking: boolean;
  /** The Document named when it was pressed, for when the core's answer moves on. */
  pressedFor: string | null;
  /** The User's own newest Document still being read. */
  reading: string | null;
  unread: number;
  /** Something else is asking or writing. */
  busy: boolean;
}): ReadyRow {
  if (asking) {
    // Its Documents can change while it waits (the last one read, the Question moved on): the row
    // keeps saying what the press waits for until the Answer is there.
    const document = waitingFor ?? pressedFor;
    return document === null ? { kind: "question", disabled: true } : { kind: "waiting", document };
  }
  if (question !== null) return { kind: "question", disabled: busy };
  if (reading !== null) return { kind: "reading", document: reading };
  if (unread > 0) return { kind: "unread", count: unread };
  return { kind: "own" };
}
