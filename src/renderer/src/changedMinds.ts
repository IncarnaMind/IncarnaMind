/**
 * The Minds an Answer in the assistant changed or made (#202), from its Tool
 * calls: what its card lists (`MindChangesCard`). Only data.
 */
import type { ConversationAnswer } from "../../core/api";

/**
 * A Mind an Answer changed or made, the requests its changes there belong to,
 * and what its calls did there: paragraphs written in whole Blocks, places
 * changed, tables added, and what of those tables was kept as text: sources
 * that couldn't be linked, extra cells.
 */
export interface ChangedMind {
  mindId: string;
  created: boolean;
  requests: readonly string[];
  wrote: number;
  changed: number;
  tables: number;
  unlinkedSources: number;
  droppedSources: number;
  extraCells: number;
}

/** The Minds an Answer's calls changed or made, in the order it first changed each. */
export function changedMinds(answer: Pick<ConversationAnswer, "toolCalls">): ChangedMind[] {
  const rows = new Map<string, Omit<ChangedMind, "mindId"> & { requests: string[] }>();
  for (const call of answer.toolCalls) {
    const change = call.mindChange;
    if (!change) continue;
    const row = rows.get(change.mindId) ?? {
      created: false,
      requests: [],
      wrote: 0,
      changed: 0,
      tables: 0,
      unlinkedSources: 0,
      droppedSources: 0,
      extraCells: 0,
    };
    row.created ||= change.created;
    if (change.request && !row.requests.includes(change.request)) row.requests.push(change.request);
    const tables = change.tables ?? 0;
    // A rewrite's table is one of its changes, counted as a table, not a place.
    if (call.tool === "edit_mind" && !change.revised) row.changed += change.proposals - tables;
    else row.wrote += change.paragraphs ?? 0;
    row.tables += tables;
    row.unlinkedSources += change.unlinkedSources ?? 0;
    row.droppedSources += change.droppedSources ?? 0;
    row.extraCells += change.extraCells ?? 0;
    rows.set(change.mindId, row);
  }
  return [...rows].map(([mindId, row]) => ({ mindId, ...row }));
}
