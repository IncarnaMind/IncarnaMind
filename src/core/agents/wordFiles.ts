/**
 * `save_as_word` (#3751): a Word file of a Note, or of the agent's own Markdown with its Citation
 * tokens, written by IncarnaMind's Word export (../exports/agentWordFiles), kept as a file an agent
 * hands over is (./handedFiles), a Document in the Library with its versions and its check, and
 * saved in the Output location as Export › Word saves its file.
 * The agent writes the words and IncarnaMind the file, so the agent builds no .docx itself. Its
 * Markdown becomes Blocks as `create_mind` makes them: a token that matches nothing reads as not
 * found where it was, and the result lists it with its check, as `create_mind`'s does.
 */
import type { NodeJSON } from "../../shared/blockJson";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { mindName } from "../../shared/naming";
import { WRITTEN_ITEM } from "../agentFiles/handOver";
import type { AgentSavedFile, AgentToolName, Effect, Mind } from "../api";
import { NOT_IN_A_FOLDER_ID } from "../api";
import { NotFoundError, TranslatableError } from "../errors";
import type { WordMade, WordSaved, WordSource, WordUnreached } from "../exports/agentWordFiles";
import type { AdmittedPairing, AgentCheckedCitation, VisualLeftOut } from "./access";
import { type AgentHandedFile, type PlannedHandOver, WRITES_LIBRARY } from "./handedFiles";
import { AgentRefusedError, text } from "./refusals";

const READS_DOCUMENTS: Effect = { action: "read", scope: { kind: "documents" } };
const WRITES_OUTPUT: Effect = { action: "write", scope: { kind: "output" } };

/** What the agent is told when the file would name what it can't read, and what the User can do. */
const UNREACHED = {
  unshared: "agents.handOver.word.unshared",
  deleted: "agents.handOver.word.deleted",
  library: "agents.handOver.word.libraryFacts",
} as const satisfies Record<WordUnreached, MessageKey>;

export interface SaveAsWordInput {
  mindId?: unknown;
  markdown?: unknown;
  title?: unknown;
  folderId?: unknown;
}

export interface AgentWordFile extends AgentHandedFile {
  /** Each token of the Markdown, checked again against its Document as it is now; none for a Note. */
  citations: AgentCheckedCitation[];
  /** Each picture or chart of the Markdown that isn't in the file, and why. */
  refused: VisualLeftOut[];
  /** Where the file is on this computer, in the Output location; null when it couldn't be saved. */
  saved: string | null;
  /** Why it couldn't be saved there, in plain words; null when it was. */
  notSaved: string | null;
}

/** An agent's Markdown as Blocks under its title, as `create_mind` writes a Note of it. */
export interface DraftBlocks {
  nodes: NodeJSON[];
  citations: AgentCheckedCitation[];
  refused: VisualLeftOut[];
  /** The Documents its Citations cite. */
  documentIds: string[];
}

export interface WordFileToolContext {
  t(key: MessageKey, params?: MessageParams): string;
  handOver<T extends object>(
    tool: AgentToolName,
    summary: string,
    effects: Effect[],
    plan: (pairing: AdmittedPairing) => PlannedHandOver<T>,
  ): Promise<AgentHandedFile & T>;
  /** A Note's name, reached or not, for the activity list; "" for none. */
  noteName(mindId: string): string;
  /** A Note the pairing reaches, or a refusal that tells nothing of the others. */
  noteInScope(pairing: AdmittedPairing, mindId: string): Mind;
  /** Where a new item goes: the Folder named, of those the pairing may write in. */
  placeToWriteIn(pairing: AdmittedPairing, folderId: unknown): { id: string | null; name: string };
  /** Whether the pairing may read a Document. */
  reaches(pairing: AdmittedPairing): (documentId: string) => boolean;
  /** A name and Markdown as `create_mind` takes them, or a refusal saying why not. */
  draftTitle(value: unknown): string;
  draftText(value: unknown): string;
  draftBlocks(title: string, written: string): Promise<DraftBlocks>;
  wordFile(
    source: WordSource,
    at: string,
    reaches: (documentId: string) => boolean,
  ): Promise<WordMade>;
  saveWordFile(source: WordSource, fileName: string, data: Uint8Array): Promise<WordSaved>;
}

const ITEM = WRITTEN_ITEM;

/**
 * What the item of a Word file IncarnaMind wrote is known by, in place of a path: the Note it was
 * written from or the name of the text, and the Folder it is kept in. So the same Note or name
 * saved again in a Folder is that item's next version, and saved in another Folder is an item there.
 */
const itemOf = (from: { mindId: string } | { title: string }, folderId: string | null) => {
  const folder = folderId ?? NOT_IN_A_FOLDER_ID;
  return "mindId" in from
    ? `${ITEM}note:${from.mindId}:${folder}`
    : `${ITEM}text:${folder}:${from.title}`;
};

/** What a Word file IncarnaMind wrote was written from, by its item's path; null for a file's own path. */
export function wordItemOf(
  path: string,
): { kind: "note"; mindId: string } | { kind: "text" } | null {
  if (!path.startsWith(ITEM)) return null;
  const [kind, id] = path.slice(ITEM.length).split(":");
  if (kind === "note" && id) return { kind: "note", mindId: id };
  return kind === "text" ? { kind: "text" } : null;
}

export function createWordFileTool(context: WordFileToolContext) {
  const { t } = context;

  /** What went wrong as IncarnaMind says it, for the agent to pass on (a Note deleted meanwhile). */
  const inWords = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof TranslatableError)) throw error;
      const { wording } = error;
      throw new AgentRefusedError(
        error instanceof NotFoundError ? "not-found" : "failed",
        wording ? t(wording.key, wording.values) : error.message,
      );
    }
  };

  return {
    saveAsWord(input: SaveAsWordInput): Promise<AgentWordFile> {
      const mindId = typeof input?.mindId === "string" ? input.mindId : "";
      const named = typeof input?.title === "string" ? input.title.trim() : "";
      const effects: Effect[] = [
        mindId === "" ? READS_DOCUMENTS : { action: "read", scope: { kind: "mind", mindId } },
        WRITES_LIBRARY,
        WRITES_OUTPUT,
      ];
      const summary = named || (mindId === "" ? "" : context.noteName(mindId));
      return context.handOver<Omit<AgentWordFile, keyof AgentHandedFile>>(
        "save_as_word",
        summary,
        effects,
        (pairing) => {
          if ((input?.mindId === undefined) === (input?.markdown === undefined)) {
            throw new AgentRefusedError("invalid", t("agents.handOver.word.which"));
          }
          let made: { source: WordSource; fileName: string; data: Uint8Array } | null = null;
          let draft: DraftBlocks | null = null;
          const kept = async () => {
            if (!made) throw new Error("A Word file is saved only once it is written.");
            const { source, fileName, data } = made;
            const saved = await inWords(() => context.saveWordFile(source, fileName, data));
            const file: AgentSavedFile | undefined =
              saved.kind === "saved" ? saved.file : undefined;
            return {
              also: {
                citations: draft?.citations ?? [],
                refused: draft?.refused ?? [],
                saved: file?.path ?? null,
                notSaved: saved.kind === "not-saved" ? saved.why : null,
              },
              ...(file && { saved: file }),
            };
          };
          const write = async (source: WordSource, at: string) => {
            const word = await inWords(() =>
              context.wordFile(source, at, context.reaches(pairing)),
            );
            if (word.kind === "unreached") {
              throw new AgentRefusedError("outside-scope", t(UNREACHED[word.why]));
            }
            made = { source, fileName: word.fileName, data: word.data };
            return word.data;
          };
          if (input.mindId !== undefined) {
            const mind = context.noteInScope(pairing, text(input.mindId, "mindId", 200));
            const title =
              input.title === undefined
                ? mindName(mind) || t("mind.untitled")
                : context.draftTitle(input.title);
            const folderId = input.folderId ?? mind.folderId ?? NOT_IN_A_FOLDER_ID;
            const path = itemOf({ mindId: mind.id }, context.placeToWriteIn(pairing, folderId).id);
            return {
              path,
              folderId,
              give: async (_, at) => {
                const source: WordSource = { kind: "note", mindId: mind.id, title };
                const bytes = await write(source, at);
                return { file: { place: path, title, kind: "docx", bytes }, documentIds: [] };
              },
              kept,
              stillReached: (now) => {
                context.noteInScope(now, mind.id);
              },
            };
          }
          const title = context.draftTitle(input.title);
          const written = context.draftText(input.markdown);
          const path = itemOf({ title }, context.placeToWriteIn(pairing, input.folderId).id);
          return {
            path,
            folderId: input.folderId,
            give: async (folder, at) => {
              const blocks = await context.draftBlocks(title, written);
              draft = blocks;
              const source: WordSource = {
                kind: "text",
                title,
                nodes: blocks.nodes,
                folderId: folder.id,
              };
              const bytes = await write(source, at);
              return {
                file: { place: path, title, kind: "docx", bytes },
                documentIds: blocks.documentIds,
              };
            },
            kept,
          };
        },
      );
    },
  };
}
