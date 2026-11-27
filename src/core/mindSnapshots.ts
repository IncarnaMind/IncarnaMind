import * as Y from "yjs";
import { mindScopeIn } from "../shared/mindScope";
import { containsTable } from "./answers/checks/figureOccurrences";
import type { CellFigurePlace, FigureFootingNow, MindContentSnapshot } from "./api";
import { readTableSnapshot } from "./figureSchedule";
import type { MindContent } from "./mindContent";

/** What a Note's table figures are read against, besides its own content. */
export interface TableReadInput {
  versions: ReadonlyMap<string, string>;
  folderId: string | null;
}

interface Kept {
  storedKey: string;
  cellFigures: CellFigurePlace[];
  footing: FigureFootingNow[];
  /** Null for a Note read without decoding it: one with no table. */
  input: TableReadInput | null;
}

const sameVersions = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) =>
  a.size === b.size && [...a].every(([id, version]) => b.get(id) === version);

/**
 * Each Note's content as Home's state line reads it (`CoreApi.readMindContents`), worked out
 * only as far as it must be (#3822): a Note with no table is answered from its stored row without
 * being decoded, and a Note's table figures are kept in memory until its content, the Documents'
 * versions or its Folder change.
 */
export function createMindSnapshots(content: MindContent) {
  const kept = new Map<string, Kept>();

  const keptFor = (mindId: string, storedKey: string | null, input: () => TableReadInput) => {
    const last = storedKey === null ? undefined : kept.get(mindId);
    if (!last || last.storedKey !== storedKey) return null;
    // A Note with no figure in a table has none whatever its Documents and Folder.
    if (last.cellFigures.length === 0 && last.footing.length === 0) return last;
    if (!last.input) return null;
    const now = input();
    return now.folderId === last.input.folderId && sameVersions(now.versions, last.input.versions)
      ? last
      : null;
  };

  const readTables = (mindId: string, now: TableReadInput) =>
    content.inspectStored(
      mindId,
      async ({ state, blocks, settings, yieldTurn }): Promise<MindContentSnapshot> => {
        const { cellFigures, footing } = await readTableSnapshot(
          blocks,
          { ...now, scope: mindScopeIn(settings) },
          yieldTurn,
        );
        return { mindId, state, cellFigures, footing };
      },
      (blocks) =>
        blocks.toArray().some((child) => child instanceof Y.XmlElement && containsTable(child)),
    );

  return {
    async read(mindId: string, input: () => TableReadInput): Promise<MindContentSnapshot> {
      const storedKey = content.storedKey(mindId);
      const last = keptFor(mindId, storedKey, input);
      const state = last ? content.storedStateUndecoded(mindId) : null;
      if (last && state) {
        return { mindId, state, cellFigures: last.cellFigures, footing: last.footing };
      }
      const plain = content.storedWithoutTables(mindId);
      let now: TableReadInput | null = null;
      let snapshot: MindContentSnapshot;
      if (plain) {
        snapshot = { mindId, state: plain, cellFigures: [], footing: [] };
      } else {
        now = input();
        snapshot = await readTables(mindId, now);
      }
      // Kept only when nothing was stored for the Note while it was read across turns.
      if (storedKey !== null && content.storedKey(mindId) === storedKey) {
        kept.set(mindId, {
          storedKey,
          cellFigures: snapshot.cellFigures,
          footing: snapshot.footing,
          input: now,
        });
      }
      return snapshot;
    },

    forget(mindId: string): void {
      kept.delete(mindId);
    },
  };
}
