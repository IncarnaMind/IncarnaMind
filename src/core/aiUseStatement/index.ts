/**
 * The AI use statement of a Mind (#739): a new Mind, for the User to edit,
 * whose text states what the source Mind's own record holds of AI use. It is
 * made from the AI use record, the Mind's AI text marks and its checks, by
 * `readFigures`, and written in the interface language by `statementBlocks`.
 * The source Mind is only read. Nothing is sent anywhere.
 */
import type * as Y from "yjs";
import type { LiveDocument } from "../../shared/citations";
import type { SourceChoicesValid } from "../../shared/claimChecks";
import { translate } from "../../shared/i18n";
import { mindName } from "../../shared/naming";
import type { NodeJSON } from "../answers/blocks";
import {
  type AiUseEntry,
  type ChatProvider,
  DEFAULT_MIND_KIND,
  type KeptCitationText,
  type Mind,
} from "../api";
import { describeModel } from "../chatModelNames";
import type { Language } from "../language";
import type { NewMind } from "../minds";
import { readFigures } from "./figures";
import { statementBlocks } from "./template";

export interface AiUseStatementOptions {
  sourceChoicesValid?(mindId: string): SourceChoicesValid;
  /** Throws `NotFoundError` unless the Mind exists. */
  mind(mindId: unknown): Mind;
  /** Reads a Mind's Blocks; the Mind is left as it is. */
  read<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T;
  /** The Mind's entries in the record of AI use, their outcomes up to date. */
  entries(mindId: string): AiUseEntry[];
  providers(): Promise<ChatProvider[]>;
  documents(): readonly LiveDocument[];
  keptCitationTexts(): readonly KeptCitationText[];
  language(): Language;
  createMind(input: NewMind): Mind;
  /** Puts Blocks at the end of a Mind's text. */
  write(mindId: string, blocks: NodeJSON[]): void;
  now(): string;
}

/** A model as the statement names it: "Claude Haiku 5.5 (Anthropic)", or without the service for one on this computer. */
function modelNamer(providers: readonly ChatProvider[]) {
  return (providerId: string | null, modelId: string | null): string | null => {
    const model = describeModel(providers, providerId, modelId);
    return (
      model && (model.place.kind === "service" ? `${model.name} (${model.place.name})` : model.name)
    );
  };
}

export function createAiUseStatement(options: AiUseStatementOptions) {
  return {
    /** Makes the statement as a new Mind, in the source Mind's Folder, and returns it. */
    async create(mindId: unknown): Promise<Mind> {
      const source = options.mind(mindId);
      const language = options.language();
      const modelNames = modelNamer(await options.providers());
      const entries = options.entries(source.id);
      const figures = options.read(source.id, (fragment) =>
        readFigures({
          sourceChoicesValid: options.sourceChoicesValid?.(source.id),
          fragment,
          entries,
          documents: options.documents(),
          kept: options.keptCitationTexts(),
          folderId: source.folderId,
          modelName: modelNames,
          untitled: translate(language, "aiStatement.text.untitled"),
        }),
      );
      const name = mindName(source) || translate(language, "mind.untitled");
      const made = options.createMind({
        title: translate(language, "aiStatement.title", { name }),
        kind: DEFAULT_MIND_KIND,
        folderId: source.folderId,
      });
      options.write(made.id, statementBlocks(figures, language, options.now()));
      return options.mind(made.id);
    },
  };
}
