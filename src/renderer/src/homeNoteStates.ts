import type { Mind, MindContentSnapshot } from "../../core/api";
import {
  type DecodedHomeSnapshot,
  decodeHomeSnapshot,
  type HomeReadingContext,
  type NoteReading,
} from "./noteState";

export type HomeNoteTarget = Pick<Mind, "id" | "folderId">;
export type HomeSharedContext = Omit<HomeReadingContext, "folderId">;

interface CachedSnapshot {
  decoded: DecodedHomeSnapshot;
  folderId: string | null;
  gen: number;
}

export interface HomeNoteStateReaderOptions {
  readMindContents: (mindIds: readonly string[]) => Promise<MindContentSnapshot[]>;
  onChange: (states: ReadonlyMap<string, NoteReading>) => void;
  onError: (error: unknown) => void;
  decode?: typeof decodeHomeSnapshot;
}

/**
 * Keeps decoded Mind snapshots in memory for Home so `readMindContents` runs once per Mind on
 * launch, never repeats when the Library or Documents arrive, and on `mind.update` re-reads only
 * the Mind that changed (#3822).
 */
export function createHomeNoteStateReader({
  readMindContents,
  onChange,
  onError,
  decode = decodeHomeSnapshot,
}: HomeNoteStateReaderOptions) {
  let minds: readonly HomeNoteTarget[] = [];
  let folders = new Map<string, string | null>();
  let context: HomeSharedContext = {
    documents: null,
    keptCitationTexts: [],
    library: null,
  };
  let hasSynced = false;
  let disposed = false;
  let fetchGen = 0;
  let evalGen = 0;
  let contextGen = 0;

  const snapshots = new Map<string, CachedSnapshot>();
  const readings = new Map<string, NoteReading>();
  const requestedGen = new Map<string, number>();

  const emit = () => {
    if (!disposed) onChange(new Map(readings));
  };

  const evaluateOne = async (
    mindId: string,
    entry: CachedSnapshot,
  ): Promise<NoteReading | null> => {
    try {
      return await entry.decoded.read({
        ...context,
        folderId: folders.get(mindId) ?? null,
      });
    } catch (error) {
      // One Mind's content this version can't read must not blank every other row's state.
      console.warn(`Couldn't read the state of Mind ${mindId}; its row shows the snippet.`, error);
      return null;
    }
  };

  const evaluateIds = async (ids: readonly string[]) => {
    const run = ++evalGen;
    let changed = false;
    for (const mindId of ids) {
      if (disposed || run !== evalGen) return;
      const entry = snapshots.get(mindId);
      if (!entry || !folders.has(mindId)) continue;
      const reading = await evaluateOne(mindId, entry);
      if (disposed || run !== evalGen) return;
      if (snapshots.get(mindId) !== entry) continue;
      if (reading) {
        readings.set(mindId, reading);
      } else {
        readings.delete(mindId);
      }
      changed = true;
    }
    if (changed && !disposed && run === evalGen) emit();
  };

  const fetchIds = (ids: readonly string[]) => {
    if (disposed || ids.length === 0) return;
    const gen = ++fetchGen;
    for (const id of ids) requestedGen.set(id, gen);
    readMindContents(ids)
      .then(async (fetched) => {
        if (disposed) return;
        const byId = new Map(fetched.map((snapshot) => [snapshot.mindId, snapshot]));
        let changed = false;
        for (const mindId of ids) {
          if (disposed) return;
          if (requestedGen.get(mindId) !== gen) continue;
          const snapshot = byId.get(mindId);
          if (!snapshot || !folders.has(mindId)) {
            const old = snapshots.get(mindId);
            if (old) {
              old.decoded.dispose();
              snapshots.delete(mindId);
            }
            if (readings.delete(mindId)) changed = true;
            continue;
          }
          let decoded: DecodedHomeSnapshot;
          try {
            decoded = await decode(snapshot);
          } catch (error) {
            console.warn(
              `Couldn't read the state of Mind ${mindId}; its row shows the snippet.`,
              error,
            );
            if (readings.delete(mindId)) changed = true;
            continue;
          }
          if (disposed || requestedGen.get(mindId) !== gen || !folders.has(mindId)) {
            decoded.dispose();
            continue;
          }
          snapshots.get(mindId)?.decoded.dispose();
          const entry: CachedSnapshot = {
            decoded,
            folderId: folders.get(mindId) ?? null,
            gen,
          };
          snapshots.set(mindId, entry);
          const ctxBefore = contextGen;
          const reading = await evaluateOne(mindId, entry);
          if (disposed || snapshots.get(mindId) !== entry) continue;
          const finalReading =
            contextGen !== ctxBefore ? await evaluateOne(mindId, entry) : reading;
          if (disposed || snapshots.get(mindId) !== entry) continue;
          if (finalReading) {
            readings.set(mindId, finalReading);
          } else {
            readings.delete(mindId);
          }
          changed = true;
        }
        if (changed && !disposed) emit();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        for (const id of ids) {
          if (requestedGen.get(id) === gen && !snapshots.has(id)) requestedGen.delete(id);
        }
        onError(error);
      });
  };

  return {
    sync(nextMinds: readonly HomeNoteTarget[], nextContext: HomeSharedContext) {
      if (disposed) return;
      const contextChanged =
        hasSynced &&
        (context.documents !== nextContext.documents ||
          context.keptCitationTexts !== nextContext.keptCitationTexts ||
          context.library !== nextContext.library);
      if (contextChanged) contextGen++;
      hasSynced = true;
      minds = nextMinds;
      context = nextContext;
      const nextFolders = new Map(nextMinds.map((mind) => [mind.id, mind.folderId]));
      folders = nextFolders;

      let removed = false;
      for (const [id, entry] of [...snapshots.entries()]) {
        if (!nextFolders.has(id)) {
          entry.decoded.dispose();
          snapshots.delete(id);
          requestedGen.delete(id);
          if (readings.delete(id)) removed = true;
        }
      }
      for (const id of [...requestedGen.keys()]) {
        if (!nextFolders.has(id)) requestedGen.delete(id);
      }

      if (nextMinds.length === 0) {
        if (readings.size > 0 || removed) {
          readings.clear();
          emit();
        }
        return;
      }

      const toFetch: string[] = [];
      const toReevaluate: string[] = [];
      for (const mind of nextMinds) {
        const entry = snapshots.get(mind.id);
        if (!entry) {
          if (!requestedGen.has(mind.id)) toFetch.push(mind.id);
          continue;
        }
        if (entry.folderId !== mind.folderId) {
          if (entry.decoded.hasTables) {
            toFetch.push(mind.id);
          } else {
            entry.folderId = mind.folderId;
            toReevaluate.push(mind.id);
          }
          continue;
        }
        if (contextChanged) toReevaluate.push(mind.id);
      }

      if (removed && toReevaluate.length === 0) emit();
      if (toFetch.length > 0) fetchIds(toFetch);
      if (toReevaluate.length > 0) void evaluateIds(toReevaluate);
    },

    refresh(mindIds: readonly string[]) {
      if (disposed) return;
      const listed = new Set(minds.map((mind) => mind.id));
      const changed = [...new Set(mindIds)].filter((id) => listed.has(id));
      if (changed.length > 0) fetchIds(changed);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of snapshots.values()) entry.decoded.dispose();
      snapshots.clear();
      readings.clear();
      requestedGen.clear();
    },
  };
}
