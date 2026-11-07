import type { SharePagePreview } from "../../../core/api";
import { formatBytes } from "../../../shared/bytes";
import type { MessageKey } from "../../../shared/i18n";
import { useGap, useT } from "../i18n";
import { LARGE_BYTES, pictured, sharedSize, withFewerPictures } from "../sharePageSize";
import { ProblemLine, ProblemMark } from "./ProblemLine";

const COUNTED = {
  quotes: ["export.share.quotes.one", "export.share.quotes.other"],
  documents: ["export.share.documents.one", "export.share.documents.other"],
  pictures: ["export.share.pictures.one", "export.share.pictures.other"],
} as const satisfies Record<string, readonly [MessageKey, MessageKey]>;

const rowClass = "flex min-h-8 items-center gap-2.5 py-1.5";

export function SharePageContents({
  preview,
  textOnly,
  onChange,
}: {
  preview: SharePagePreview;
  textOnly: ReadonlySet<string>;
  onChange(textOnly: Set<string>): void;
}) {
  const t = useT();
  const gap = useGap();
  const counted = (what: keyof typeof COUNTED, count: number) =>
    count === 1 ? t(COUNTED[what][0]) : t(COUNTED[what][1], { count });
  const { bytes, pictures } = sharedSize(preview, textOnly);
  const quotes = counted(
    "quotes",
    preview.documents.reduce((sum, document) => sum + document.quotes, 0),
  );
  const documents = counted("documents", preview.documents.length);
  const contents =
    pictures > 0
      ? t("export.share.contents", { quotes, pictures: counted("pictures", pictures), documents })
      : t("export.share.contents.text", { quotes, documents });
  const toggle = (documentId: string, shown: boolean) => {
    const next = new Set(textOnly);
    if (shown) next.delete(documentId);
    else next.add(documentId);
    onChange(next);
  };
  const size = formatBytes(bytes, t);
  const label = t("export.share.inFile");
  const readers = t("export.share.readers");

  return (
    <div
      data-testid="share-contents"
      className="mb-2 rounded-lg bg-frame px-3.5 py-3 text-[13px] leading-[19px] text-ink"
    >
      <p>
        <strong className="font-semibold">{label}</strong>
        {gap(label, contents)}
        {contents}
        {gap(contents, readers)}
        {readers}
      </p>
      <ul className="mt-2.5 border-t border-rule">
        {preview.documents.map((document) => {
          const shown = pictured(document, textOnly);
          const meta =
            document.pictures === 0
              ? counted("quotes", document.quotes)
              : `${counted("quotes", document.quotes)} · ${
                  shown ? counted("pictures", document.pictures) : t("export.share.textOnly")
                }`;
          const words = (
            <>
              <span className="min-w-0 flex-1 truncate">{document.name}</span>
              <span className="shrink-0 text-[12px] text-ink-meta">{meta}</span>
            </>
          );
          return (
            <li key={document.documentId} className="border-b border-rule">
              {document.pictures > 0 ? (
                <label data-testid="share-document" className={rowClass} title={document.name}>
                  <input
                    type="checkbox"
                    checked={shown}
                    onChange={(event) => toggle(document.documentId, event.target.checked)}
                    className="size-[15px] shrink-0 accent-ink"
                  />
                  {words}
                </label>
              ) : (
                <div data-testid="share-document" className={rowClass} title={document.name}>
                  <span aria-hidden="true" className="size-[15px] shrink-0" />
                  {words}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {bytes >= LARGE_BYTES ? (
        <ProblemLine
          role="status"
          testId="share-large"
          className="mt-2"
          action={{
            label: t("export.share.fewer"),
            testId: "share-fewer",
            onClick: () => onChange(withFewerPictures(preview, textOnly)),
          }}
        >
          <ProblemMark />
          {pictures === 1
            ? t("export.share.large.one", { size })
            : t("export.share.large.other", { count: pictures, size })}
        </ProblemLine>
      ) : (
        <p data-testid="share-size" className="mt-2 text-[12.5px] leading-[18px] text-ink-meta">
          {t("export.share.size", { size })}
        </p>
      )}
    </div>
  );
}
