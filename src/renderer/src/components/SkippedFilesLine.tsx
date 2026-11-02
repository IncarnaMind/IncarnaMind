import { type ReactNode, useEffect, useState } from "react";
import { skippedStep } from "../../../shared/skippedFiles";
import { core } from "../core";
import { showFileLabelKey } from "../fileInfo";
import { useT } from "../i18n";
import { type SkippedFileInfo, useAppStore } from "../store";
import { MetaLine } from "./MetaLine";
import { LineAction, ProblemLine } from "./ProblemLine";

/**
 * What the files an add skipped need: each with its plain next step (#762) —
 * save an old Office file as .docx in Word, export a Pages document as PDF —
 * and Show in Finder. A file whose kind LibreOffice converts offers Convert
 * with LibreOffice where this computer has one: the copy is added, and the
 * original is never changed. Nothing when no add skipped a file.
 */
export function SkippedFilesLine({
  files,
  testId = "skipped-files",
  className = "",
}: {
  files: readonly SkippedFileInfo[];
  testId?: string;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const converter = useOfficeConverter(
    files.some((file) => file.path !== null && skippedStep(file.name).convert !== null),
  );
  if (files.length === 0) return null;
  // One file: its next step and what to do about it show without a click.
  if (files.length === 1 && files[0]) {
    return (
      <div data-testid={testId} className={className}>
        <SkippedFilesList files={files} converter={converter} />
      </div>
    );
  }
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
        {t("skipped.count.other", { count: files.length })}
      </ProblemLine>
      {open && <SkippedFilesList files={files} converter={converter} />}
    </div>
  );
}

/**
 * The same, as a footer status's details: Show in the line, the files and
 * their next steps under it. A hook, so a status that has files gets it.
 */
export function useSkippedFilesDetails(
  files: readonly SkippedFileInfo[],
  testId: string,
): { toggle: ReactNode; panel: ReactNode } {
  const t = useT();
  const [open, setOpen] = useState(false);
  // The status goes when nothing is left; a later add starts folded again.
  useEffect(() => {
    if (files.length === 0) setOpen(false);
  }, [files.length]);
  const converter = useOfficeConverter(
    files.some((file) => file.path !== null && skippedStep(file.name).convert !== null),
  );
  return {
    toggle: (
      <LineAction
        action={{
          label: open ? t("unread.hide") : t("unread.show"),
          testId: `${testId}-show`,
          onClick: () => setOpen((now) => !now),
        }}
      />
    ),
    panel: open ? <SkippedFilesList files={files} converter={converter} /> : null,
  };
}

/** Whether this computer has the LibreOffice that converts a copy (#762), asked once, when one is needed. */
let converter: Promise<boolean> | null = null;

function useOfficeConverter(needed: boolean): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!needed) return;
    converter ??= core.officeConverter().then(
      (answer) => answer.available,
      () => false,
    );
    let current = true;
    void converter.then((answer) => {
      if (current) setAvailable(answer);
    });
    return () => {
      current = false;
    };
  }, [needed]);
  return available;
}

function SkippedFilesList({
  files,
  converter,
}: {
  files: readonly SkippedFileInfo[];
  converter: boolean;
}) {
  return (
    <ul data-testid="skipped-files-list" className="mt-1 flex flex-col gap-1">
      {files.map((file) => (
        <SkippedFileRow key={file.path ?? file.name} file={file} converter={converter} />
      ))}
    </ul>
  );
}

/**
 * One skipped file: its next step, and what the User can do about it here.
 * Convert reads it into a copy the Library takes; Show in Finder opens where
 * it is, for the app that can save it as a kind IncarnaMind reads.
 */
function SkippedFileRow({ file, converter }: { file: SkippedFileInfo; converter: boolean }) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [converting, setConverting] = useState(false);
  const [failed, setFailed] = useState(false);
  const step = skippedStep(file.name);
  const convertible = converter && step.convert !== null && file.path !== null;
  const convert = async () => {
    if (!file.path || converting) return;
    setConverting(true);
    setFailed(false);
    try {
      const result = await core.convertWithOffice(file.path);
      if (result.outcome === "added") {
        useAppStore.setState((state) => ({
          skippedFiles: state.skippedFiles.filter(
            (each) => each.path !== file.path || each.name !== file.name,
          ),
        }));
      } else if (result.problem !== "unsupported") setFailed(true);
    } catch (error) {
      setFailed(true);
      reportError(error);
    } finally {
      setConverting(false);
    }
  };
  return (
    <li
      data-testid="skipped-file"
      className="font-sans text-[13px] leading-5 break-words text-ink-meta"
    >
      <MetaLine
        as="div"
        parts={[
          <>
            <span data-testid="skipped-file-name">{file.name}</span>
            {t("skipped.file.reason", {
              reason: t(
                convertible && step.convert !== null ? "skipped.next.convert" : step.message,
                { ext: step.convert === null ? "" : `.${step.convert}` },
              ),
            })}
          </>,
          convertible && (
            <LineAction
              action={{
                label: t(converting ? "skipped.converting" : "skipped.convert"),
                testId: "skipped-convert",
                disabled: converting,
                onClick: () => void convert(),
              }}
            />
          ),
          file.path !== null && (
            <LineAction
              action={{
                label: t(showFileLabelKey(navigator.platform)),
                testId: "skipped-show",
                onClick: () =>
                  void core
                    .showSkippedFile(file.path ?? "")
                    .catch((error: unknown) => reportError(error)),
              }}
            />
          ),
          failed && <span data-testid="skipped-convert-failed">{t("skipped.convert.failed")}</span>,
        ]}
      />
    </li>
  );
}
