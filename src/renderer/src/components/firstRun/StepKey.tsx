import { useEffect, useId, useRef, useState } from "react";
import type { SecretStorageStatus } from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useMounted } from "../../useMounted";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemLine } from "../ProblemLine";
import { SecretStorageNotice } from "../providers/ProviderForm";
import { useProviderKey } from "../providers/shared";
import { fieldClass, fieldLabelClass, hintClass } from "../ui";

/**
 * A step's key and what saving it says (#3296): the step's own primary checks, saves and chooses in
 * one press. `save` runs that; it returns why it couldn't, in the User's words ("" when a line of
 * its own already says so), or null once done. A refusal puts the focus back in the field.
 */
export function useStepKey() {
  const t = useT();
  const key = useProviderKey();
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const mounted = useMounted();
  useEffect(() => {
    core.getSecretStorage().then(setStorage, (failure: unknown) => {
      console.error("The keychain's state couldn't be read.", failure);
    });
  }, []);
  const blocked = key.text !== "" && storage !== null && !storage.canSave;
  return {
    key,
    field,
    busy,
    problem,
    storage,
    /** The keychain can't keep the key: the User allows keeping it in plain text. */
    async acceptPlainText() {
      try {
        setStorage(await core.acceptPlainTextSecretStorage());
      } catch (failure) {
        setProblem(errorMessage(failure, t));
      }
    },
    /** A key is typed that can be kept here. */
    typed: key.text !== "" && key.stray === null && !blocked,
    /** What the field holds now: a line about the key before it goes. */
    type(value: string) {
      key.type(value);
      setProblem(null);
    },
    reset() {
      key.clear();
      setProblem(null);
    },
    async save(run: () => Promise<string | null>): Promise<boolean> {
      if (busy) return false;
      setBusy(true);
      setProblem(null);
      try {
        const why = await run();
        if (!mounted()) return why === null;
        if (why === null) {
          key.clear();
          return true;
        }
        setProblem(why || null);
      } catch (failure) {
        if (mounted()) setProblem(errorMessage(failure, t));
      } finally {
        if (mounted()) setBusy(false);
      }
      field.current?.focus();
      field.current?.select();
      return false;
    },
  };
}

export type StepKey = ReturnType<typeof useStepKey>;

/** "{Provider} key", with where to get one beside its label, and what saving it says under it. */
export function StepKeyField({
  step,
  label,
  keyUrl,
  testId,
  onEnter,
}: {
  step: StepKey;
  label: string;
  keyUrl: string | null;
  testId: string;
  onEnter(): void;
}) {
  const t = useT();
  const id = useId();
  const { key } = step;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={`${id}-key`} className={`${fieldLabelClass} font-semibold`}>
          {label}
        </label>
        {keyUrl && (
          <a
            href={keyUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[12px] leading-[18px] text-ink-meta underline underline-offset-2 hover:text-ink"
          >
            {t("meetings.key.get")} ↗
          </a>
        )}
      </div>
      <input
        ref={step.field}
        id={`${id}-key`}
        type="password"
        data-testid={testId}
        value={key.apiKey}
        placeholder={t("setup.key.placeholder")}
        onChange={(event) => step.type(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (step.typed) onEnter();
        }}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={key.stray !== null || step.problem !== null || undefined}
        aria-describedby={`${id}-line`}
        className={`${fieldClass} w-full`}
      />
      {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
      <div id={`${id}-line`}>
        {step.busy ? (
          <p role="status" data-testid={`${testId}-checking`} className={`${hintClass} mt-0`}>
            {t("setup.key.checking")}
          </p>
        ) : (
          step.problem && (
            <ProblemLine
              testId={`${testId}-problem`}
              action={{
                label: t("setup.key.check"),
                testId: `${testId}-check`,
                onClick: () => {
                  step.field.current?.focus();
                  step.field.current?.select();
                },
              }}
            >
              {step.problem}
            </ProblemLine>
          )
        )}
      </div>
      {step.storage && !step.storage.canSave && (
        <SecretStorageNotice status={step.storage} onAccept={() => void step.acceptPlainText()} />
      )}
    </div>
  );
}
