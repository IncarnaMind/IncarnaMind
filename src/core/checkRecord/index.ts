/**
 * The check record of a Mind (#738): what IncarnaMind checked in it and how, as a PDF to file with
 * the work or a CSV for the User's own records. It is made from what the Mind keeps of its
 * checks (see ./read), on this computer; the host decides where the bytes go, and nothing is sent.
 */
import type * as Y from "yjs";
import { checkedScope } from "../../shared/claimChecks";
import type { MessageKey } from "../../shared/i18n";
import { mindName } from "../../shared/naming";
import type { PrintPaper } from "../../shared/printDocument";
import { readableQuoteText } from "../../shared/readableQuote";
import { SCOPE_KINDS, type ScopeKind, scopeIds } from "../../shared/searchScope";
import { checkUnreadOf } from "../../shared/unreadFiles";
import type { Printer } from "../adapters";
import type {
  ChatProvider,
  CheckRecordFormat,
  CitationAttributes,
  Document,
  FigureScheduleRow,
  KeptCitationText,
  Mind,
  UnreadFile,
} from "../api";
import { describeModel } from "../chatModelNames";
import { TranslatableError } from "../errors";
import { unifyIdeographs } from "../exports/pdfUnicode";
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
  /** A Folder's, Tag's or Document's name; null for one that isn't there. */
  scopeItemName(kind: ScopeKind, id: string): string | null;
  localMode(): boolean;
  language(): Language;
  printer: Printer | null;
  paper(): PrintPaper;
  now(): string;
  /** The note's Figure schedule: the figures of its one Check (#1932). */
  figures(mindId: string): readonly FigureScheduleRow[];
  /** The User, whose own check marks are theirs (#1933); null before they make one. */
  personId(): string | null;
}

const GONE: Record<ScopeKind, MessageKey> = {
  folder: "checkRecord.summary.folderGone",
  tag: "scope.chip.deleted.tag",
  document: "scope.chip.deleted.document",
};

export interface CheckRecord {
  mind: string;
  /** When it was made, ISO 8601 UTC. */
  exportedAt: string;
  /** What the sentence checks searched; empty when none ran. */
  searched: string[];
  localMode: boolean;
  models: string[];
  /** What the checks couldn't read when they started (#740); empty when they read everything. */
  unread: UnreadFile[];
  sentences: SentenceItem[];
  citations: CitationItem[];
  figures: readonly FigureScheduleRow[];
  language: Language;
}

export interface CheckRecordFile {
  fileName: string;
  data: Uint8Array;
}

export interface CheckRecordMaker {
  format: CheckRecordFormat;
  make(): Promise<CheckRecordFile>;
}

export function createCheckRecord(deps: CheckRecordDependencies) {
  async function build(mindId: unknown): Promise<CheckRecord> {
    const mind = deps.mind(mindId);
    const language = deps.language();
    const providers = await deps.providers();
    const t = translatorFor(language);
    const { sentences, citations, unread } = deps.read(mind.id, (fragment) => {
      const record = readRecord({
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
        personId: deps.personId(),
      });
      return {
        ...record,
        unread: fragment.doc ? checkUnreadOf(fragment.doc, record.requests) : [],
      };
    });

    const searched = new Set<string>();
    const models = new Map<string, number>();
    for (const { check } of sentences) {
      if (!check) continue;
      const looked = checkedScope(check.scope);
      const names = looked
        ? SCOPE_KINDS.flatMap((kind) =>
            scopeIds(looked, kind).map((id) => deps.scopeItemName(kind, id) ?? t(GONE[kind])),
          )
        : [t("checkRecord.summary.allDocuments")];
      for (const name of names) searched.add(name);
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
      unread,
      sentences,
      citations,
      figures: deps.figures(mind.id),
      language,
    };
  }

  return {
    build,

    /** The record's files, the PDF first, each made when asked so that one failing leaves the other. */
    async files(mindId: unknown): Promise<CheckRecordMaker[]> {
      const record = await build(mindId);
      const { language } = record;
      const t = translatorFor(language);
      const base = t("checkRecord.fileName", { name: safeFileName(record.mind, "Note") });
      return [
        {
          format: "pdf",
          async make() {
            if (!deps.printer) throw new TranslatableError({ key: "error.checkRecord.noPdf" });
            const printed = await deps.printer.print({
              language,
              paper: deps.paper(),
              title: base,
              body: renderRecordHtml(record),
              notes: [],
              footer: t("checkRecord.note"),
            });
            return { fileName: `${base}.pdf`, data: unifyIdeographs(printed) };
          },
        },
        {
          format: "csv",
          async make() {
            return { fileName: `${base}.csv`, data: new TextEncoder().encode(renderCsv(record)) };
          },
        },
      ];
    },
  };
}
