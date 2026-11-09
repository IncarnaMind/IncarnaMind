import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type {
  DecisionHostStatus,
  SecretStorageStatus,
  SetDecisionKeyInput,
  TaggingClassifier,
} from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { useMounted } from "../../useMounted";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemLine } from "../ProblemLine";
import { buttonStyle, fieldLabelClass, hintClass, inputClass } from "../ui";
import { SecretStorageNotice } from "./ProviderForm";
import { SortingLine } from "./SortingChoice";
import { useProviderKey } from "./shared";

const linkClass = "underline underline-offset-2 hover:text-ink";

export const firstModelOf = (host: DecisionHostStatus): TaggingClassifier => ({
  kind: "decision",
  host: host.host,
  modelId: host.models[0]?.id ?? "",
});

export const hostName = (host: DecisionHostStatus, language: string) =>
  host.name[language === "zh-CN" ? "zh" : "en"];

/**
 * A decision model host's key of its own, and the account it asks for (Cloudflare's account ID,
 * the Model Studio workspace): checked with the host as it is saved, nothing of the User's sent.
 * From the sorting picker (`sorting`), its one button saves them and makes the host's best model
 * what sorts, with the line that says what that sends above it: that press is the consent.
 */
export function DecisionKeyForm({
  host,
  sorting,
  onSaved,
  onCancel,
}: {
  host: DecisionHostStatus;
  sorting?: { consent: ReactNode; choose(): Promise<boolean> };
  onSaved(hosts: DecisionHostStatus[], chosen: boolean): void;
  onCancel(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const key = useProviderKey();
  const [account, setAccount] = useState(host.account?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const mounted = useMounted();
  useEffect(() => {
    core.getSecretStorage().then(setStorage, (failure: unknown) => {
      console.error("The keychain's state couldn't be read.", failure);
    });
    first.current?.focus({ preventScroll: true });
    first.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const name = hostName(host, language);
  const ownKey = host.key === "own";
  const keyBlocked = key.text !== "" && storage !== null && !storage.canSave;
  const ready =
    (!ownKey || key.text !== "" || host.hasKey) &&
    (!host.account || account.trim() !== "") &&
    key.stray === null &&
    !keyBlocked;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setProblem(null);
    const input: SetDecisionKeyInput = {
      host: host.host,
      ...(key.text && { apiKey: key.text }),
      ...(host.account && { account: account.trim() }),
    };
    try {
      const hosts = await core.setDecisionKey(input);
      // The User left the form while the key was checked: it is kept, nothing is chosen.
      if (!mounted()) return;
      key.clear();
      onSaved(hosts, sorting ? await sorting.choose() : false);
    } catch (failure) {
      if (mounted()) setProblem(errorMessage(failure, t));
    } finally {
      if (mounted()) setBusy(false);
    }
  };

  const acceptPlainText = async () => {
    try {
      setStorage(await core.acceptPlainTextSecretStorage());
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };

  const fieldClass = sorting ? `${inputClass} max-w-[26rem]` : inputClass;
  return (
    <form
      data-testid={`decision-key-form-${host.host}`}
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Esc puts the form away before it closes Settings.
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onCancel();
      }}
      className="flex flex-col gap-3"
    >
      {ownKey && (
        <label className={fieldLabelClass}>
          {t("decisions.form.apiKey", { provider: name })}
          <input
            ref={first}
            type="password"
            data-testid="decision-key-input"
            value={key.apiKey}
            onChange={(event) => key.type(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={key.stray ? true : undefined}
            aria-describedby={key.stray ? `${id}-stray` : `${id}-get`}
            className={fieldClass}
          />
          {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
          <span id={`${id}-get`} className={hintClass}>
            {host.hasKey && `${t("providers.form.apiKeySaved")} `}
            <a href={host.keyUrl} target="_blank" rel="noreferrer" className={linkClass}>
              {t("meetings.key.get")} ↗
            </a>
          </span>
        </label>
      )}
      {host.account && (
        <label className={fieldLabelClass}>
          {t(`decisions.account.${host.account.kind}`)}
          <input
            ref={ownKey ? undefined : first}
            type="text"
            data-testid="decision-account-input"
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-account`}
            className={fieldClass}
          />
          <span id={`${id}-account`} className={hintClass}>
            {t(`decisions.account.hint.${host.account.kind}`)}
          </span>
        </label>
      )}
      {storage && !storage.canSave && (
        <SecretStorageNotice status={storage} onAccept={() => void acceptPlainText()} />
      )}
      {sorting?.consent}
      {problem && <ProblemLine testId="decision-key-problem">{problem}</ProblemLine>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="submit"
          data-testid="decision-key-save"
          disabled={!ready || busy}
          className={buttonStyle("primary", sorting ? "sm" : undefined)}
        >
          {t(busy ? "meetings.key.checking" : sorting ? "setup.step.useThis" : "meetings.key.save")}
        </button>
        <button
          type="button"
          data-testid="decision-key-cancel"
          onClick={onCancel}
          disabled={busy}
          className="text-[13px] leading-5 font-semibold text-ink-secondary hover:text-ink"
        >
          {t("library.cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * A host chosen from the sorting picker's foot (#1907): what its best model is, then its key and
 * account, with what choosing it sends above Use this, which keeps them and makes it what sorts.
 */
export function DecisionSortingSetUp({
  host,
  choose,
  onChosen,
  onCancel,
}: {
  host: DecisionHostStatus;
  choose(): Promise<boolean>;
  onChosen(): void;
  onCancel(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const name = hostName(host, language);
  const model = host.models[0];
  return (
    <div data-testid="decision-sorting-set-up" className="flex flex-col gap-2">
      <p data-testid="decision-sorting-line" className={`${hintClass} mt-0`}>
        {model && model.maker !== name
          ? t("decisions.setUp.line", { maker: model.maker, provider: name })
          : t("decisions.setUp.lineOwn", { maker: name })}{" "}
        <span aria-hidden="true">· </span>
        <a href={host.pricingUrl} target="_blank" rel="noreferrer" className={linkClass}>
          {t("providers.form.pricing")} ↗
        </a>
      </p>
      <DecisionKeyForm
        host={host}
        sorting={{
          consent: (
            <SortingLine
              option={{
                classifier: firstModelOf(host),
                label: model?.name ?? name,
                provider: name,
                decisionModel: true,
              }}
              choosing={false}
            />
          ),
          choose,
        }}
        onSaved={(_hosts, chosen) => {
          if (chosen) onChosen();
        }}
        onCancel={onCancel}
      />
    </div>
  );
}
