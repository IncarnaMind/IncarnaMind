import { useEffect, useState } from "react";
import type { FileWriteRequest } from "../../../core/api";
import { core } from "../core";
import { errorMessage } from "../errors";
import { useT } from "../i18n";
import { folderName } from "../linkedFolders";
import { chooseOutputLocation, defaultFolderLabel } from "../outputFiles";
import { useAppStore } from "../store";
import { PathText } from "./PathText";
import { ProblemLine } from "./ProblemLine";
import {
  buttonClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  hintClass,
  primaryButtonClass,
} from "./ui";
import { useModal } from "./useModal";

/**
 * Asks once before a save that needs the User's answer (the core raises the
 * question and waits): where new files go, when none is chosen and the
 * default, Documents › IncarnaMind (D209), can't take them, saying why; or
 * whether it may add files to a Linked folder, the first time a file would go
 * inside one. Esc cancels the first, which saves nothing; the second is
 * remembered, so it must be answered.
 */
export function FileWriteDialog() {
  const t = useT();
  const [queue, setQueue] = useState<FileWriteRequest[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const add = (requests: readonly FileWriteRequest[]) =>
      setQueue((current) => [
        ...current,
        ...requests.filter((request) =>
          current.every((queued) => queued.requestId !== request.requestId),
        ),
      ]);
    const stopRequested = core.on("fileWrite.requested", (request) => add([request]));
    const stopResolved = core.on("fileWrite.resolved", ({ requestId }) =>
      setQueue((current) => current.filter((request) => request.requestId !== requestId)),
    );
    // Questions raised before this window was listening.
    core.listFileWriteRequests().then(add, () => undefined);
    return () => {
      stopRequested();
      stopResolved();
    };
  }, []);

  const request = queue[0];
  const dialog = useModal(request !== undefined);

  // Closes at once, before the save goes on, so the focus is back where the save was asked from.
  const respond = async (accept: boolean) => {
    if (!request) return;
    setProblem(null);
    setQueue((current) => current.filter((queued) => queued.requestId !== request.requestId));
    try {
      await core.respondToFileWrite(request.requestId, accept);
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    }
  };

  const chooseAnother = async () => {
    if (!request) return;
    setProblem(null);
    try {
      if (await chooseOutputLocation()) {
        setQueue((current) => current.filter((queued) => queued.requestId !== request.requestId));
      }
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };

  return (
    <dialog
      ref={dialog}
      data-testid="file-write-dialog"
      data-kind={request?.kind}
      aria-labelledby="file-write-title"
      onCancel={(event) => {
        event.preventDefault();
        if (request?.kind === "output-location") void respond(false);
      }}
      className={`${dialogClass} w-[30rem]`}
    >
      {request?.kind === "output-location" && (
        <div className={dialogBodyClass}>
          <h2 id="file-write-title" className={dialogTitleClass}>
            {t("fileWrite.location.title")}
          </h2>
          <p data-testid="file-write-unusable" className={dialogTextClass}>
            {t(
              request.problem === "missing"
                ? "fileWrite.location.missing"
                : "fileWrite.location.notWritable",
              { name: request.fileName, folder: defaultFolderLabel(t) },
            )}
          </p>
          {problem && (
            <ProblemLine testId="file-write-problem">
              {t("fileWrite.location.failed", { reason: problem })}
            </ProblemLine>
          )}
          <div className={dialogActionsClass}>
            <button
              type="button"
              data-testid="file-write-cancel"
              onClick={() => void respond(false)}
              className={buttonClass}
            >
              {t("fileWrite.location.cancel")}
            </button>
            <button
              type="button"
              data-testid="file-write-choose"
              onClick={() => void chooseAnother()}
              className={primaryButtonClass}
            >
              {t("fileWrite.location.choose")}
            </button>
          </div>
        </div>
      )}
      {request?.kind === "linked-folder" && (
        <div className={dialogBodyClass}>
          <h2 id="file-write-title" className={dialogTitleClass}>
            {t("fileWrite.linked.title", { folder: folderName(request.linkedFolderPath) })}
          </h2>
          <p className={dialogTextClass}>
            {t("fileWrite.linked.body", {
              folder: folderName(request.linkedFolderPath),
              name: request.fileName,
            })}
          </p>
          <p className={dialogTextClass}>{t("fileWrite.linked.safe")}</p>
          <FolderPath path={request.linkedFolderPath} testId="file-write-linked-folder" />
          <p className={hintClass}>{t("fileWrite.linked.note")}</p>
          <div className={dialogActionsClass}>
            <button
              type="button"
              data-testid="file-write-deny"
              onClick={() => void respond(false)}
              className={buttonClass}
            >
              {t("fileWrite.linked.deny")}
            </button>
            <button
              type="button"
              data-testid="file-write-allow"
              onClick={() => void respond(true)}
              className={primaryButtonClass}
            >
              {t("fileWrite.linked.allow")}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** The folder a question is about, in a box on its own line. */
function FolderPath({ path, testId }: { path: string; testId: string }) {
  return (
    <PathText
      path={path}
      testId={testId}
      className="rounded-md border border-rule bg-frame px-3 py-2 font-mono text-[13px] leading-5 text-ink-secondary"
    />
  );
}
