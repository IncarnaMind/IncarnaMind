import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { SecretStorageStatus, TranscriptionServiceStatus } from "../../../../core/api";
import { typedServerChecksKey } from "../../../../shared/deepgram";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ROUTE_LABELS, useTranscriptionServices } from "../../transcriptionServices";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemLine } from "../ProblemLine";
import { SecretStorageNotice } from "../providers/ProviderForm";
import { useProviderKey } from "../providers/shared";
import { buttonStyle, fieldLabelClass, hintClass, inputClass } from "../ui";

const fieldClass = `${inputClass} max-w-[26rem]`;
const linkClass = "underline decoration-rule-strong underline-offset-2 hover:text-ink";

/**
 * A transcription service's own key (Soniox's, Deepgram's, AssemblyAI's, ElevenLabs',
 * Speechmatics', Gladia's), with Deepgram's server, where it isn't Deepgram's own: Cloudflare
 * Workers AI's or the User's, whose key may be left out. Save checks the key with the service
 * where it has a check, except in Local mode, and keeps it in the keychain. From the Meeting
 * transcription picker (`choosing`), its one button keeps the key and chooses the service, with
 * where the audio goes above it: that press is the consent (ADR-0022).
 */
export function TranscriptionKeyForm({
  service,
  choosing,
  onSaved,
  onCancel,
}: {
  service: TranscriptionServiceStatus;
  /** `consent`: where the audio goes, as the server typed (Deepgram's) makes it. */
  choosing?: { consent(server: string): ReactNode; choose(): Promise<boolean> };
  /** `unchecked`: kept in Local mode without the check Save would make. */
  onSaved(saved: { unchecked: boolean; chosen: boolean }): void;
  onCancel(): void;
}) {
  const t = useT();
  const id = useId();
  const takesServer = service.route === "deepgram";
  const [server, setServer] = useState(service.server ?? "");
  const key = useProviderKey();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const keyField = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    core.getSecretStorage().then(setStorage, (failure: unknown) => {
      console.error("The keychain's state couldn't be read.", failure);
    });
    keyField.current?.focus({ preventScroll: true });
    keyField.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const name = t(ROUTE_LABELS[service.route]);
  const checksKey = takesServer ? typedServerChecksKey(server) : service.keyChecked;
  const given = key.text !== "" || (takesServer && server.trim() !== "");
  const keyBlocked = key.text !== "" && storage !== null && !storage.canSave;
  const ready = given && key.stray === null && !keyBlocked;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setProblem(null);
    const unchecked = localMode && checksKey && key.text !== "";
    try {
      await useTranscriptionServices
        .getState()
        .setKey(service.route, key.text, takesServer ? server : undefined);
      // The User left the form while the key was checked: it is kept, nothing is chosen.
      if (!mounted.current) return;
      key.clear();
      onSaved({ unchecked, chosen: choosing ? await choosing.choose() : false });
    } catch (failure) {
      if (mounted.current) setProblem(errorMessage(failure, t));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const acceptPlainText = async () => {
    try {
      setStorage(await core.acceptPlainTextSecretStorage());
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };

  return (
    <form
      data-testid={`transcription-key-form-${service.route}`}
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
      {takesServer && (
        <div className="flex flex-col">
          <label htmlFor={`${id}-server`} className={fieldLabelClass}>
            {t("meetings.key.server")}
          </label>
          <input
            id={`${id}-server`}
            type="url"
            autoComplete="off"
            spellCheck={false}
            data-testid="transcription-key-server"
            placeholder={t("meetings.key.serverPlaceholder")}
            aria-describedby={`${id}-server-tip`}
            value={server}
            onChange={(event) => setServer(event.target.value)}
            className={fieldClass}
          />
          <span id={`${id}-server-tip`} className={hintClass}>
            {t("meetings.key.serverTip")}
          </span>
        </div>
      )}
      <div className="flex flex-col">
        <label htmlFor={`${id}-key`} className={fieldLabelClass}>
          {t("meetings.key.title", { provider: name })}
        </label>
        <input
          ref={keyField}
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-testid="transcription-key-input"
          placeholder={t("meetings.key.placeholder")}
          aria-invalid={key.stray ? true : undefined}
          aria-describedby={key.stray ? `${id}-stray` : `${id}-kept`}
          value={key.apiKey}
          onChange={(event) => key.type(event.target.value)}
          className={fieldClass}
        />
        {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
        <span id={`${id}-kept`} data-testid="transcription-key-kept" className={hintClass}>
          {t(checksKey && !localMode ? "meetings.key.lineChecked" : "meetings.key.line", {
            provider: name,
          })}
          {service.keyUrl && (
            <>
              {" "}
              <a href={service.keyUrl} target="_blank" rel="noreferrer" className={linkClass}>
                {t("meetings.key.get")} ↗
              </a>
            </>
          )}
        </span>
      </div>
      {storage && !storage.canSave && (
        <SecretStorageNotice status={storage} onAccept={() => void acceptPlainText()} />
      )}
      {choosing?.consent(takesServer ? server : "")}
      {problem && <ProblemLine testId="transcription-key-problem">{problem}</ProblemLine>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="submit"
          data-testid="transcription-key-save"
          disabled={!ready || busy}
          className={buttonStyle("primary", "sm")}
        >
          {t(
            busy ? "meetings.key.checking" : choosing ? "setup.step.useThis" : "meetings.key.save",
          )}
        </button>
        <button
          type="button"
          data-testid="transcription-key-cancel"
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
