/**
 * The Minds an Answer in the assistant changed or made (#202), from its Tool
 * calls: what its card lists (`MindChangesCard`). Only data.
 */
import type { ChartProblem, ConversationAnswer, ConversationMessage } from "../../core/api";

/**
 * A Mind an Answer changed or made, the requests its changes there belong to,
 * and what its calls did there: paragraphs written in whole Blocks, paragraphs
 * changed, tables and charts added, and what of those tables was kept as text: sources
 * that couldn't be linked, extra cells.
 */
export interface ChangedMind {
  mindId: string;
  created: boolean;
  /** It was written into while it held nothing: the empty Mind in front (#1559). */
  filled: boolean;
  requests: readonly string[];
  wrote: number;
  changed: number;
  tables: number;
  charts: number;
  /** Why the last chart asked for there wasn't drawn; null when none was refused. */
  chartNotDrawn: ChartProblem | null;
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
      filled: false,
      requests: [],
      wrote: 0,
      changed: 0,
      tables: 0,
      charts: 0,
      chartNotDrawn: null,
      unlinkedSources: 0,
      droppedSources: 0,
      extraCells: 0,
    };
    row.created ||= change.created;
    row.filled ||= change.filled === true;
    if (change.request && !row.requests.includes(change.request)) row.requests.push(change.request);
    const tables = change.tables ?? 0;
    const replaced = change.replacedOwn;
    // Counted by paragraph; an Answer's calls from before that counted Proposals, a table one of them.
    if (call.tool === "edit_mind" && !change.revised) {
      row.changed += change.changed ?? change.proposals - tables;
    } else row.wrote += (change.paragraphs ?? 0) - (replaced?.paragraphs ?? 0);
    row.tables += tables - (replaced?.tables ?? 0);
    row.charts += (change.charts ?? 0) - (replaced?.charts ?? 0);
    if (change.chartNotDrawn) row.chartNotDrawn = change.chartNotDrawn;
    row.unlinkedSources += change.unlinkedSources ?? 0;
    row.droppedSources += change.droppedSources ?? 0;
    row.extraCells += change.extraCells ?? 0;
    rows.set(change.mindId, row);
  }
  return [...rows].map(([mindId, row]) => ({ mindId, ...row }));
}

/** The requests each Answer in the thread made in one Mind: a hold that needs several of them reads them as one. */
export function answerGroups(messages: readonly ConversationMessage[], mindId: string): string[][] {
  return messages
    .flatMap((message) =>
      message.kind === "answer"
        ? changedMinds(message)
            .filter((row) => row.mindId === mindId)
            .map((row) => [...row.requests])
        : [],
    )
    .filter((group) => group.length > 0);
}
