import { type RefObject, useEffect, useId, useRef, useState } from "react";
import type { ChatProvider, ProviderError } from "../../../../core/api";
import { serviceOfKey } from "../../../../core/providers/catalog/keyForms";
import {
  billingUrlOf,
  catalogProvider,
  kindOfCatalogId,
} from "../../../../core/providers/catalog/providers";
import { checkApiKey } from "../../../../shared/apiKey";
import type { MessageKey } from "../../../../shared/i18n";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemLine } from "../ProblemLine";
import { hintClass, inputClass } from "../ui";
import { defaultRegion, testErrorKey } from "./shared";

type Problem =
  | { kind: "stray"; character: string }
  | { kind: "unrecognised" }
  | { kind: "refused"; error: ProviderError; catalogId: string; endpoint: string | null };

/**
 * The one key field of first run (#1922): a pasted key is named by its prefix, tested and saved
 * at once, with no provider list and no button between. A form no prefix names waits for the
 * User to say which service it is, through `unrecognised`; Enter does what a paste does.
 */
export function KeyEntry({
  onSaved,
  unrecognised,
  testId = "setup-key",
  autoFocus = false,
  inputRef,
}: {
  /** The saved provider, and the model it was saved with, for the work that waited on it. */
  onSaved(provider: ChatProvider, model: { providerId: string; modelId: string }): void;
  /** The way on for a key whose form names no service we list, with the key as typed. */
  unrecognised: { label: MessageKey; run(key: string): void };
  testId?: string;
  autoFocus?: boolean;
  /** Where another way in can lead the User: the field itself. */
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const t = useT();
  const language = useLanguage();
  const reportError = useAppStore((state) => state.reportError);
  const id = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const own = useRef<HTMLInputElement>(null);
  const field = inputRef ?? own;
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus, field]);

  const chooseField = () => {
    field.current?.focus();
    field.current?.select();
  };

  const attempt = async (text: string) => {
    if (busy) return;
    const { key, stray } = checkApiKey(text);
    if (key === "") return;
    if (stray !== null) {
      setProblem({ kind: "stray", character: stray });
      return;
    }
    const named = serviceOfKey(key);
    const catalog = catalogProvider(named);
    const modelId = catalog?.roles.answers;
    if (!named || !catalog || !modelId) {
      setProblem({ kind: "unrecognised" });
      return;
    }
    const region = defaultRegion(named, language);
    const endpoint = region === "" ? null : region;
    setProblem(null);
    setBusy(true);
    try {
      const request = {
        kind: kindOfCatalogId(named),
        catalogId: named,
        modelId,
        apiKey: key,
        ...(endpoint !== null && { endpoint }),
      };
      const result = await core.testChatConnection(request);
      if (!result.ok) {
        setProblem({ kind: "refused", error: result.error, catalogId: named, endpoint });
        return;
      }
      const provider = await core.saveChatProvider(request);
      setValue("");
      setProblem(null);
      onSaved(provider, { providerId: provider.id, modelId });
    } catch (failure) {
      reportError(failure);
    } finally {
      setBusy(false);
    }
  };

  const refusedCatalog = problem?.kind === "refused" ? catalogProvider(problem.catalogId) : null;
  const billing =
    refusedCatalog && problem?.kind === "refused"
      ? billingUrlOf(refusedCatalog, problem.endpoint)
      : undefined;
  const refusedLine =
    problem?.kind === "refused"
      ? t(testErrorKey(problem.error.kind), { model: refusedCatalog?.roles.answers ?? "" })
      : "";

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={field}
        id={`${id}-key`}
        type="password"
        value={value}
        aria-label={t("setup.key.label")}
        aria-invalid={problem !== null || undefined}
        aria-describedby={`${id}-line`}
        autoComplete="off"
        spellCheck={false}
        placeholder={t("setup.key.placeholder")}
        data-testid={testId}
        onChange={(event) => {
          setValue(event.target.value);
          if (problem !== null) setProblem(null);
        }}
        onInput={(event) => {
          if ((event.nativeEvent as InputEvent).inputType === "insertFromPaste") {
            void attempt(event.currentTarget.value);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void attempt(event.currentTarget.value);
        }}
        className={inputClass}
      />
      <p id={`${id}-line`} data-testid={`${testId}-line`} className={hintClass}>
        {busy ? t("setup.key.checking") : t("setup.key.recognised")}
      </p>
      {problem?.kind === "stray" && (
        <KeyCharacterLine id={`${id}-stray`} stray={problem.character} />
      )}
      {problem?.kind === "unrecognised" && (
        <ProblemLine
          testId={`${testId}-unrecognised`}
          action={{
            label: t(unrecognised.label),
            testId: `${testId}-choose-service`,
            onClick: () => unrecognised.run(checkApiKey(value).key),
          }}
        >
          {t("setup.key.unrecognised")}
        </ProblemLine>
      )}
      {problem?.kind === "refused" && problem.error.kind === "auth" && (
        <ProblemLine
          testId={`${testId}-refused`}
          action={{
            label: t("setup.key.check"),
            testId: `${testId}-check`,
            onClick: chooseField,
          }}
        >
          {t("setup.key.refused")}
        </ProblemLine>
      )}
      {problem?.kind === "refused" && problem.error.kind === "out-of-credit" && (
        <ProblemLine
          testId={`${testId}-refused`}
          action={
            billing
              ? {
                  label: t("setup.key.addCredit"),
                  testId: `${testId}-credit`,
                  onClick: () => window.open(billing, "_blank", "noreferrer"),
                }
              : undefined
          }
          also={{
            label: t("setup.key.another"),
            testId: `${testId}-another`,
            onClick: chooseField,
          }}
        >
          {t("setup.key.credit")}
        </ProblemLine>
      )}
      {problem?.kind === "refused" &&
        problem.error.kind !== "auth" &&
        problem.error.kind !== "out-of-credit" && (
          <ProblemLine testId={`${testId}-refused`} title={problem.error.message}>
            {refusedLine}
          </ProblemLine>
        )}
    </div>
  );
}
