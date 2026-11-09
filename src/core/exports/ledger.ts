/**
 * The exports IncarnaMind saved since the app opened, and each Change made to one (#110, #2927):
 * what a later Change may write over, what its Undo puts back, and one of either at a time for a
 * file. A file the User changed since is never written over.
 */
import { basename, dirname } from "node:path";
import type { ExportFormat, ExportMindOptions, OwnFileKind, SavedFile } from "../api";
import { InvalidInputError, TranslatableError } from "../errors";
import { fileProblem, fingerprintOf, type OutputFiles } from "../outputFiles";

export const ownFileOf = (options: Pick<ExportMindOptions, "format">): OwnFileKind =>
  options.format === "source-pack" ? "source-pack" : "export";

/** An export saved since the app opened. */
export interface KnownExport {
  /** The Note it came from. */
  mindId: string;
  path: string;
  format: ExportFormat;
  /** The fingerprint of the bytes IncarnaMind last wrote there. */
  wrote: string;
}

/**
 * One Change of an export: the id its Undo names, so an Undo refused on one side never makes the
 * next one put back the wrong step; the bytes it replaced, null where it wrote a copy beside; and
 * the Note's comment choice before it, null where it set none.
 */
interface Step {
  id: string;
  before: Uint8Array | null;
  comments: boolean | null;
}

export interface ExportLedgerOptions {
  outputs: Pick<OutputFiles, "rewrite" | "save" | "remove">;
  /** The Folder of a Note, whose wall a file written from it stays behind; null for none. */
  folderOf(mindId: string): string | null;
}

export function createExportLedger({ outputs, folderOf }: ExportLedgerOptions) {
  const files = new Map<string, KnownExport>();
  /** Each export's Changes by the path they wrote, newest last. */
  const steps = new Map<string, Step[]>();
  const turns = new Map<string, Promise<void>>();

  const keepStep = (path: string, before: Uint8Array | null, comments: boolean | null) => {
    const id = crypto.randomUUID();
    steps.set(path, [...(steps.get(path) ?? []), { id, before, comments }]);
    return id;
  };
  const ownFile = (known: KnownExport) => ({
    kind: ownFileOf(known),
    fromFolder: folderOf(known.mindId),
  });

  return {
    /**
     * Changes and Undos of one export run one after another, each reading what the last one
     * wrote, so two at once never both write over the same bytes.
     */
    inTurn<T>(path: unknown, run: () => Promise<T>): Promise<T> {
      const key = typeof path === "string" ? path : "";
      const turn = (turns.get(key) ?? Promise.resolve()).then(run);
      const settled = turn.then(
        () => undefined,
        () => undefined,
      );
      turns.set(key, settled);
      void settled.then(() => {
        if (turns.get(key) === settled) turns.delete(key);
      });
      return turn;
    },

    /** An export was saved: `data` is what its file holds. */
    saved(file: Omit<KnownExport, "wrote">, data: Uint8Array): void {
      files.set(file.path, { ...file, wrote: fingerprintOf(data) });
    },

    /** The export saved at `path`. Throws InvalidInputError unless it is this Note's, in this format. */
    known(path: unknown, mindId: string, format: ExportFormat | undefined): KnownExport {
      const known = typeof path === "string" ? files.get(path) : undefined;
      if (!known || known.mindId !== mindId || known.format !== format) {
        throw new InvalidInputError({ key: "error.export.rewrite.notThisNote" });
      }
      return known;
    },

    /**
     * Writes an export again, in place while its file still holds what IncarnaMind wrote. A file
     * the User changed since, or made read-only, is left as it is: the bytes go in a copy beside
     * it, and `changedFile` names the one left. `comments` is the Note's comment choice before
     * this Change, which its Undo gives back.
     */
    async rewrite(
      known: KnownExport,
      data: Uint8Array,
      comments: boolean | null,
    ): Promise<{ file: SavedFile; step: string; changedFile?: string }> {
      const own = ownFile(known);
      const written = await outputs.rewrite(known.path, data, known.wrote, own);
      let file: SavedFile;
      let changedFile: string | undefined;
      let step: string;
      if (written.kind === "written") {
        file = written.file;
        step = keepStep(file.path, written.before, comments);
      } else {
        changedFile = basename(known.path);
        try {
          file = await outputs.save({
            name: changedFile,
            data,
            ownFile: own.kind,
            fromFolder: own.fromFolder,
            folder: dirname(known.path),
            approved: true,
          });
        } catch (error) {
          throw fileProblem(changedFile, error);
        }
        step = keepStep(file.path, null, comments);
      }
      files.set(file.path, { ...known, path: file.path, wrote: fingerprintOf(data) });
      return { file, step, ...(changedFile !== undefined && { changedFile }) };
    },

    /**
     * Takes back the newest Change of the export at `path`: its file holds what it held before,
     * or the copy the Change wrote is removed. Gives the Note and the comment choice to give back,
     * null for none. Throws, with nothing written, for a path or a step it doesn't know, a step
     * that isn't the file's newest, and a file that is changed since, gone or read-only.
     */
    async restore(
      path: unknown,
      step: unknown,
    ): Promise<{ mindId: string; comments: boolean | null }> {
      const known = typeof path === "string" ? files.get(path) : undefined;
      const taken = known ? steps.get(known.path) : undefined;
      const at = taken?.findIndex((each) => each.id === step) ?? -1;
      const kept = taken?.[at];
      if (!known || !taken || !kept) {
        throw new InvalidInputError({
          key: "error.export.restore.nothing",
          values: { name: typeof path === "string" ? basename(path) : "" },
        });
      }
      const values = { name: basename(known.path) };
      const changed = new TranslatableError({ key: "error.export.restore.changed", values });
      // A later Change wrote the file since: this step's bytes would take that one back too.
      if (at < taken.length - 1) throw changed;
      const own = ownFile(known);
      const done = kept.before
        ? await outputs.rewrite(known.path, kept.before, known.wrote, own)
        : await outputs.remove(known.path, known.wrote);
      if (done.kind === "gone") {
        // The copy can never come back to be taken away, so its step goes with it.
        files.delete(known.path);
        steps.delete(known.path);
        throw new TranslatableError({ key: "error.export.restore.copyGone" });
      }
      if (done.kind === "changed") throw changed;
      if (done.kind === "read-only") {
        throw new TranslatableError({ key: "error.export.rewrite.locked", values });
      }
      if (kept.before) files.set(known.path, { ...known, wrote: fingerprintOf(kept.before) });
      else files.delete(known.path);
      taken.pop();
      if (taken.length === 0) steps.delete(known.path);
      return { mindId: known.mindId, comments: kept.comments };
    },
  };
}

export type ExportLedger = ReturnType<typeof createExportLedger>;
