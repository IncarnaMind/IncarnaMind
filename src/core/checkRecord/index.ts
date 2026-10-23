/**
 * The check record of a Mind (#738): what IncarnaMind checked in it and how, as a PDF to file with
 * the work or a CSV for the User's own records. It is made from what the Mind keeps of its
 * checks (see ./read), on this computer; the host decides where the bytes go, and nothing is sent.
 */
import type * as Y from "yjs";
import { mindName } from "../../shared/naming";
import type { PrintPaper } from "../../shared/printDocument";
import { readableQuoteText } from "../../shared/readableQuote";
import type { Printer } from "../adapters";
import {
  CHECK_RECORD_FORMATS,
  type ChatProvider,
  type CheckRecordFormat,
  type CitationAttributes,
  type Document,
  type KeptCitationText,
  type Mind,
} from "../api";
import { describeModel } from "../chatModelNames";
import { InvalidInputError, TranslatableError } from "../errors";
import { printedPdf } from "../exports/printedPdf";
import { safeFileName } from "../fileNames";
import type { Language } from "../language";
import { renderCsv } from "./csv";
import { renderRecordHtml } from "./html";
import { modelLabel, translatorFor } from "./labels";
import { type CitationItem, readRecord, type SentenceItem } from "./read";

export interface CheckRecordDependencies {
  /** Throws `NotFoundError` unless the Mind exists. */
  mind(mindId: unknown): Mind;
  /** Reads a Mind's Blocks; the Mind is left as it is. */
  read<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T;
  providers(): Promise<ChatProvider[]>;
  documents(): readonly Document[];
  keptCitationTexts(): readonly KeptCitationText[];
  /** A Citation's quote as its Document's text reads it, or null when the Document or the quote isn't there. */
  readableQuote(attributes: Partial<CitationAttributes>): string | null;
  /** A Folder's name; null for one that isn't there. */
  folderName(folderId: string): string | null;
  localMode(): boolean;
  language(): Language;
  printer: Printer | null;
  paper(): PrintPaper;
  now(): string;
}

export interface CheckRecord {
  mind: string;
  /** When it was made, ISO 8601 UTC. */
  exportedAt: string;
  /** What the sentence checks searched; empty when none ran. */
  searched: string[];
  localMode: boolean;
  models: string[];
  sentences: SentenceItem[];
  citations: CitationItem[];
  language: Language;
}

export interface CheckRecordFile {
  fileName: string;
  data: Uint8Array;
}

function parseFormat(format: unknown): CheckRecordFormat {
  const known = CHECK_RECORD_FORMATS.find((each) => each === format);
  if (!known) throw new InvalidInputError({ key: "error.checkRecord.format" });
  return known;
}

export function createCheckRecord(deps: CheckRecordDependencies) {
  async function build(mindId: unknown): Promise<CheckRecord> {
    const mind = deps.mind(mindId);
    const language = deps.language();
    const providers = await deps.providers();
    const t = translatorFor(language);
    const { sentences, citations } = deps.read(mind.id, (fragment) =>
      readRecord({
        fragment,
        documents: deps.documents(),
        kept: deps.keptCitationTexts(),
        folderId: mind.folderId,
        t,
        model: (providerId, modelId) => describeModel(providers, providerId, modelId),
        readQuote: (attributes) =>
          attributes.quote
            ? (deps.readableQuote(attributes) ?? readableQuoteText(attributes.quote))
            : null,
      }),
    );

    const searched = new Set<string>();
    const models = new Map<string, number>();
    for (const { check } of sentences) {
      if (!check) continue;
      const { folderId, widened } = check.scope;
      searched.add(
        widened || folderId === null
          ? t("checkRecord.summary.allDocuments")
          : (deps.folderName(folderId) ?? t("checkRecord.summary.folderGone")),
      );
      const label = check.model ? modelLabel(check.model, t) : t("checkRecord.notRecorded");
      models.set(label, (models.get(label) ?? 0) + 1);
    }

    return {
      mind: mindName(mind) || t("mind.untitled"),
      exportedAt: deps.now(),
      searched: [...searched],
      localMode: deps.localMode(),
      models: [...models]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([model, count]) =>
          count === 1
            ? t("checkRecord.models.one", { model })
            : t("checkRecord.models.other", { model, count }),
        ),
      sentences,
      citations,
      language,
    };
  }

  return {
    build,

    async file(mindId: unknown, format: unknown): Promise<CheckRecordFile> {
      const chosen = parseFormat(format);
      const record = await build(mindId);
      const { language } = record;
      const t = translatorFor(language);
      const base = t("checkRecord.fileName", { name: safeFileName(record.mind, "Mind") });
      if (chosen === "csv") {
        return {
          fileName: `${base}.csv`,
          data: new TextEncoder().encode(renderCsv(record)),
        };
      }
      if (!deps.printer) throw new TranslatableError({ key: "error.checkRecord.noPdf" });
      const data = await printedPdf(deps.printer, {
        language,
        paper: deps.paper(),
        title: base,
        body: renderRecordHtml(record),
        notes: [],
        footer: t("checkRecord.note"),
      });
      return { fileName: `${base}.pdf`, data };
    },
  };
}
