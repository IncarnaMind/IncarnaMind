import { useId, useState } from "react";
import type { UnreadFile } from "../../../core/api";
import { UNREAD_REASON_KEYS, unreadPartsText } from "../../../shared/unreadFiles";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { MetaLine } from "./MetaLine";
import { LineAction, ProblemLine } from "./ProblemLine";

/**
 * "3 files couldn't be read · Show" (#740; DESIGN.md, Problems): beside an
 * Answer, the Mind's checks and a Verify run, and in the Library, when a file
 * in what was searched couldn't be read. Show lists each with why and what to
 * do. Nothing when there are none: a line that always showed would be one
 * nobody read.
 */
export function UnreadFilesLine({
  files,
  testId = "unread-files",
  className = "",
}: {
  files: readonly UnreadFile[];
  testId?: string;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (files.length === 0) return null;
  return (
    <div data-testid={testId} className={className}>
      <ProblemLine
        role="status"
        action={{
          label: open ? t("unread.hide") : t("unread.show"),
          testId: `${testId}-show`,
          onClick: () => setOpen((now) => !now),
        }}
      >
        {t(files.length === 1 ? "unread.count.one" : "unread.count", { count: files.length })}
      </ProblemLine>
      {open && (
        <ul id={listId} data-testid={`${testId}-list`} className="mt-1 flex flex-col gap-1">
          {files.map((file) => (
            <UnreadFileRow key={file.id} file={file} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A file that couldn't be read, and why. A Document's name opens it (#485). A
 * scan some of whose pages weren't read can be read again: text recognition
 * runs by itself, so "Read with OCR" is the Document's Retry, which reads
 * those pages. A locked PDF offers Unlock…, which opens it where its password
 * is asked for (#763).
 */
function UnreadFileRow({ file }: { file: UnreadFile }) {
  const t = useT();
  const { documentId } = file;
  const openDocument = useAppStore((state) => state.openDocument);
  const retryDocument = useAppStore((state) => state.retryDocument);
  const readHiddenSheets = useAppStore((state) => state.readHiddenSheets);
  const retryable = useAppStore((state) =>
    state.documents.some(
      (each) =>
        each.id === documentId && each.status === "failed" && each.fileStatus === "available",
    ),
  );
  const lockedPdf = useAppStore((state) =>
    file.reason === "password"
      ? (state.documents.find((each) => each.id === documentId && each.kind === "pdf") ?? null)
      : null,
  );
  // The list may be a check's snapshot: read hidden sheets only while the Document still has some.
  const hiddenWorkbook = useAppStore((state) =>
    file.reason === "parts" && documentId !== null
      ? (state.documents.find(
          (each) =>
            each.id === documentId &&
            each.kind === "xlsx" &&
            each.fileStatus === "available" &&
            each.status !== "queued" &&
            each.status !== "extracting" &&
            (each.unreadParts?.hiddenSheets.length ?? 0) > 0,
        ) ?? null)
      : null,
  );
  return (
    <li
      data-testid="unread-file"
      data-reason={file.reason}
      className="font-sans text-[13px] leading-5 break-words text-ink-meta"
    >
      <MetaLine
        as="div"
        parts={[
          <>
            {documentId === null ? (
              file.name
            ) : (
              <button
                type="button"
                data-testid="unread-file-open"
                onClick={() => openDocument({ documentId })}
                className="rounded-sm text-accent underline-offset-2 hover:underline"
              >
                {file.name}
              </button>
            )}
            {t("unread.file.reason", {
              reason:
                file.reason === "parts" && file.parts
                  ? unreadPartsText(file.parts, t, true)
                  : lockedPdf
                    ? t("unread.reason.passwordPdf")
                    : t(UNREAD_REASON_KEYS[file.reason], { extension: file.extension ?? "" }),
            })}
          </>,
          lockedPdf?.fileStatus === "available" && (
            <LineAction
              action={{
                label: t("documents.unlockAction"),
                testId: "unread-file-unlock",
                onClick: () => openDocument({ documentId: lockedPdf.id }),
              }}
            />
          ),
          file.reason === "pages" && retryable && documentId !== null && (
            <LineAction
              action={{
                label: t("unread.ocr"),
                testId: "unread-file-ocr",
                onClick: () => void retryDocument(documentId),
              }}
            />
          ),
          hiddenWorkbook !== null && (
            <LineAction
              action={{
                label: t("documents.readHiddenSheets"),
                testId: "unread-file-hidden-sheets",
                onClick: () => void readHiddenSheets(hiddenWorkbook.id),
              }}
            />
          ),
        ]}
      />
    </li>
  );
}
