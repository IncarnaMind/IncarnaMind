/**
 * `save_as_word` (#3751): a Word file of a Note, or of the agent's own Markdown with its Citation
 * tokens, written by IncarnaMind's Word export with the User's choices for it, and kept as a file
 * an agent hands over is (./handedFiles): a Document in the Library with its versions and its
 * check. The agent writes the words and IncarnaMind the file, so the agent builds no .docx itself.
 * Its Markdown becomes Blocks as `create_mind` makes them: a token that matches nothing reads as
 * not found where it was, and the result lists it with its check, as `create_mind`'s does.
 */
import type { NodeJSON } from "../../shared/blockJson";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { mindName } from "../../shared/naming";
import type { AgentToolName, Effect, Mind } from "../api";
import { NOT_IN_A_FOLDER_ID } from "../api";
import type { AdmittedPairing, AgentCheckedCitation, VisualLeftOut } from "./access";
import { type AgentHandedFile, type PlannedHandOver, WRITES_LIBRARY } from "./handedFiles";
import { AgentRefusedError, text } from "./refusals";

const READS_DOCUMENTS: Effect = { action: "read", scope: { kind: "documents" } };

/** What a Word file is written from: a Note, or an agent's Blocks as a new Note of them. */
export type WordSource =
  | { kind: "note"; mindId: string }
  | { kind: "text"; title: string; nodes: NodeJSON[]; folderId: string | null };

/** A Word file IncarnaMind wrote, and how much of a Note's own Word file it couldn't keep. */
export interface WordMade {
  data: Uint8Array;
  /** What a Note imported from a Word file has that its file couldn't keep (#105). */
  lost: number;
}

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
  /** A name and Markdown as `create_mind` takes them, or a refusal saying why not. */
  draftTitle(value: unknown): string;
  draftText(value: unknown): string;
  draftBlocks(title: string, written: string): Promise<DraftBlocks>;
  wordFile(source: WordSource): Promise<WordMade>;
}

/**
 * What the item of a Word file IncarnaMind wrote is known by, in place of a path: the Note it was
 * written from, or the name of the text. No file's path is like it, since `hand_over_file` takes
 * only a full one, so the same Note or name saved again is the item's next version.
 */
const itemOf = (source: { mindId: string } | { title: string }) =>
  "mindId" in source ? `incarnamind:note:${source.mindId}` : `incarnamind:text:${source.title}`;

export function createWordFileTool(context: WordFileToolContext) {
  const { t } = context;
  return {
    saveAsWord(input: SaveAsWordInput): Promise<AgentWordFile> {
      const mindId = typeof input?.mindId === "string" ? input.mindId : "";
      const named = typeof input?.title === "string" ? input.title.trim() : "";
      const effects: Effect[] = [
        mindId === "" ? READS_DOCUMENTS : { action: "read", scope: { kind: "mind", mindId } },
        WRITES_LIBRARY,
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
          if (input.mindId !== undefined) {
            const mind = context.noteInScope(pairing, text(input.mindId, "mindId", 200));
            const title =
              input.title === undefined
                ? mindName(mind) || t("mind.untitled")
                : context.draftTitle(input.title);
            const path = itemOf({ mindId: mind.id });
            return {
              path,
              folderId: input.folderId ?? mind.folderId ?? NOT_IN_A_FOLDER_ID,
              give: async () => {
                const made = await context.wordFile({ kind: "note", mindId: mind.id });
                if (made.lost > 0)
                  throw new AgentRefusedError("invalid", t("error.commands.wordLoses"));
                return {
                  file: { place: path, title, kind: "docx", bytes: made.data },
                  also: { citations: [], refused: [] },
                  documentIds: [],
                };
              },
            };
          }
          const title = context.draftTitle(input.title);
          const written = context.draftText(input.markdown);
          const path = itemOf({ title });
          return {
            path,
            folderId: input.folderId,
            give: async (folder) => {
              const draft = await context.draftBlocks(title, written);
              const made = await context.wordFile({
                kind: "text",
                title,
                nodes: draft.nodes,
                folderId: folder.id,
              });
              return {
                file: { place: path, title, kind: "docx", bytes: made.data },
                also: { citations: draft.citations, refused: draft.refused },
                documentIds: draft.documentIds,
              };
            },
          };
        },
      );
    },
  };
}
