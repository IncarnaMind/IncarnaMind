/**
 * What an Answer did to the workspace, held to its request: the Minds as the
 * core holds them once the Answer has ended, then what Reject all, Undo and
 * Accept all make of them, as the card's buttons do (./state).
 */
import type { ConversationAnswer, Core } from "../../src/core";
import { toolRecordLines } from "../../src/core/answers/toolRecord";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import type { MindsCase } from "./cases";
import {
  acceptFailures,
  cardFailures,
  type MindsFailure,
  rejectFailures,
  textFailures,
  undoFailures,
  unnamedFailure,
} from "./checks";
import type { CardRow } from "./report";
import { changeStatesOf, decideAll, type MindState, readWorkspace } from "./state";

export interface Examined {
  failures: MindsFailure[];
  /** What the app recorded its Tools doing. */
  calls: string[];
  card: CardRow[];
}

/** What the User reads: the reply, and a question the assistant asked in its place. */
export const saidOf = (answer: ConversationAnswer): string =>
  [
    answer.text,
    ...answer.toolCalls.flatMap((call) =>
      call.asked ? [call.asked.question, ...(call.asked.detail ? [call.asked.detail] : [])] : [],
    ),
  ]
    .filter((part) => part.trim() !== "")
    .join("\n");

/** `judge` says which sentences of the reply claim a change the record doesn't show. */
export async function examine(
  core: Core,
  each: MindsCase,
  before: readonly MindState[],
  answer: ConversationAnswer,
  judge: (reply: string, calls: readonly string[]) => Promise<readonly string[]>,
): Promise<Examined> {
  const rows = changedMinds(answer);
  const waiting = await readWorkspace(core);
  const titleOf = (id: string) => waiting.find((mind) => mind.id === id)?.title ?? null;
  const calls = toolRecordLines(
    answer.toolCalls,
    titleOf,
    await changeStatesOf(core, rows, answer.toolCalls),
  );
  const said = saidOf(answer);
  const unbacked = await judge(said, calls);

  const rejected = await decideAll(core, rows, "reject");
  const afterReject = await readWorkspace(core);
  await rejected.undo();
  const afterRejectUndo = await readWorkspace(core);
  const accepted = await decideAll(core, rows, "accept");
  const afterAccept = await readWorkspace(core);
  await accepted.undo();
  const afterAcceptUndo = await readWorkspace(core);

  return {
    failures: [
      ...textFailures(each.expected, before, afterAccept),
      ...unnamedFailure(each.expected, said),
      ...cardFailures(rows, before, afterAccept),
      ...(unbacked.length > 0
        ? [
            {
              kind: "unbacked" as const,
              sentences: [...unbacked],
              flagged: (answer.steps?.unbackedClaims ?? []).length > 0,
            },
          ]
        : []),
      ...rejectFailures(before, afterReject),
      ...acceptFailures(afterAccept),
      ...undoFailures("Reject all", waiting, afterRejectUndo),
      ...undoFailures("Accept all", waiting, afterAcceptUndo),
    ],
    calls,
    card: rows.map((row) => ({
      mind: titleOf(row.mindId) ?? row.mindId,
      created: row.created,
      changed: row.changed,
      wrote: row.wrote,
    })),
  };
}
