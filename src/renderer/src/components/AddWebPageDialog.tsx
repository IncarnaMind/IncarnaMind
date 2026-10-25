import { type FormEvent, useEffect, useId, useState } from "react";
import { typedAddresses } from "../../../shared/webAddresses";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import {
  canTryAgain,
  heldInLocalMode,
  reasonKey,
  siteOf,
  useWebPages,
  type WebPageProblem,
} from "../webPages";
import { DetailsLine } from "./DetailsLine";
import { ProblemLine } from "./ProblemLine";
import { TypingTextarea } from "./TypingTextarea";
import {
  buttonClass,
  checkBoxClass,
  checkHintClass,
  checkRowClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  fieldLabelClass,
  inputClass,
  primaryButtonClass,
} from "./ui";
import { useModal } from "./useModal";

/**
 * "Add a web page…": the addresses, one per line, and whether to keep the
 * pages as they look, ticked as Settings say. Once added, it shows how each
 * goes: fetching, added, or why it couldn't be, with "Try again", and closes
 * by itself once every page is added. ⌘↵ (Ctrl+Enter) adds, Esc closes.
 */
export function AddWebPageDialog() {
  const t = useT();
  const open = useWebPages((state) => state.dialogOpen);
  const submitted = useWebPages((state) => state.dialogAddresses);
  const fetching = useWebPages((state) => state.fetching);
  const problems = useWebPages((state) => state.problems);
  const close = useWebPages((state) => state.closeDialog);
  const keepByDefault = useAppStore((state) => state.settings?.user.keepWebPageLook === true);
  const dialog = useModal(open);
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [keepLook, setKeepLook] = useState(keepByDefault);
  const id = useId();
  const lines = typedAddresses(text);
  const invalid = lines.find((line) => line.address === null);
  const addresses = lines.flatMap((line) => (line.address ? [line.address] : []));
  const problemOf = (address: string) => problems.find((each) => each.key === address);
  const allAdded =
    submitted.length > 0 &&
    submitted.every((address) => !fetching.includes(address) && !problemOf(address));

  const finish = () => {
    setText("");
    setTried(false);
    close();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: closes once, when the last page is added
  useEffect(() => {
    if (open && allAdded) finish();
  }, [open, allAdded]);

  useEffect(() => {
    if (open) setKeepLook(keepByDefault);
  }, [open, keepByDefault]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    setTried(true);
    if (invalid || addresses.length === 0) return;
    void useWebPages.getState().submitDialog(addresses, keepLook);
  };

  return (
    <dialog
      ref={dialog}
      onClose={finish}
      data-testid="add-web-page-dialog"
      aria-labelledby={`${id}-title`}
      className={`${dialogClass} w-[30rem]`}
    >
      <form className={dialogBodyClass} onSubmit={submit}>
        <h2 id={`${id}-title`} className={dialogTitleClass}>
          {t("webPages.add.title")}
        </h2>
        {submitted.length === 0 ? (
          <>
            <p className={dialogTextClass}>{t("webPages.add.note")}</p>
            <DetailsLine
              testId="add-web-page-fetch"
              className={dialogTextClass}
              details={t(
                keepLook ? "webPages.add.fetch.details.keepLook" : "webPages.add.fetch.details",
              )}
            >
              {t("webPages.add.fetch")}
            </DetailsLine>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-addresses`} className={fieldLabelClass}>
                {t("webPages.add.label")}
              </label>
              <TypingTextarea
                id={`${id}-addresses`}
                data-testid="add-web-page-addresses"
                value={text}
                rows={4}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="https://"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
                }}
                className={`${inputClass} resize-y font-mono text-[13px] leading-5`}
              />
              {tried && invalid && (
                <ProblemLine testId="add-web-page-invalid">
                  {t("webPages.add.invalid", { line: invalid.line })}
                </ProblemLine>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className={checkRowClass}>
                <input
                  type="checkbox"
                  data-testid="add-web-page-keep-look"
                  checked={keepLook}
                  aria-describedby={`${id}-keep-look`}
                  onChange={(event) => setKeepLook(event.target.checked)}
                  className={checkBoxClass}
                />
                {t("webPages.add.keepLook")}
              </label>
              <p id={`${id}-keep-look`} className={checkHintClass}>
                {t("webPages.keepLook.body")}
              </p>
            </div>
          </>
        ) : (
          <ul data-testid="add-web-page-results" className="flex flex-col gap-3">
            {submitted.map((address) => (
              <AddressResult
                key={address}
                address={address}
                fetching={fetching.includes(address)}
                problem={problemOf(address)}
              />
            ))}
          </ul>
        )}
        <div className={dialogActionsClass}>
          {submitted.length === 0 ? (
            <>
              <button type="button" onClick={finish} className={buttonClass}>
                {t("webPages.add.cancel")}
              </button>
              <button
                type="submit"
                data-testid="add-web-page-confirm"
                disabled={addresses.length === 0}
                className={primaryButtonClass}
              >
                {t("webPages.add.confirm")}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="add-web-page-done"
              onClick={finish}
              className={buttonClass}
            >
              {t("webPages.add.done")}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}

function AddressResult({
  address,
  fetching,
  problem,
}: {
  address: string;
  fetching: boolean;
  problem: WebPageProblem | undefined;
}) {
  const t = useT();
  const reason = problem && t(reasonKey(problem.reason));
  return (
    <li data-testid="add-web-page-result" data-address={address} className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-3 text-[13px] leading-5">
        <span title={address} className="min-w-0 flex-1 truncate font-mono text-ink">
          {address}
        </span>
        {!problem && (
          <span className="shrink-0 text-ink-meta">
            {t(fetching ? "webPages.add.fetching" : "webPages.add.added")}
          </span>
        )}
      </div>
      {problem && reason && heldInLocalMode(problem) && (
        <ProblemLine
          testId="add-web-page-problem"
          action={{
            label: t("webPages.localMode.once"),
            testId: "add-web-page-fetch-once",
            disabled: fetching,
            onClick: () => void useWebPages.getState().tryAgain(problem, true),
          }}
          also={{
            label: t("webPages.localMode.keep"),
            testId: "add-web-page-keep-local",
            onClick: () => useWebPages.getState().dismiss(problem),
          }}
        >
          {t("webPages.localMode", { site: siteOf(problem.address) })}
        </ProblemLine>
      )}
      {problem && reason && !heldInLocalMode(problem) && (
        <ProblemLine
          testId="add-web-page-problem"
          title={problem.message}
          action={
            canTryAgain(problem)
              ? {
                  label: t("webPages.tryAgain"),
                  testId: "add-web-page-try-again",
                  disabled: fetching,
                  onClick: () => void useWebPages.getState().tryAgain(problem),
                }
              : undefined
          }
        >
          {t(canTryAgain(problem) ? "webPages.couldNotFetch" : "webPages.notAdded", { reason })}
        </ProblemLine>
      )}
    </li>
  );
}
