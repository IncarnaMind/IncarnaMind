import { useEffect, useId, useState } from "react";
import type { SecretStorageStatus, TranscriptionServiceStatus } from "../../../../core/api";
import { checkApiKey } from "../../../../shared/apiKey";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  ROUTE_LABELS,
  serviceMeta,
  useTranscriptionServices,
  useTranscriptionServicesList,
} from "../../transcriptionServices";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemLine } from "../ProblemLine";
import { SecretStorageNotice } from "../providers/ProviderForm";
import {
  buttonStyle,
  inputClass,
  rowButtonsClass,
  rowStatusClass,
  rowTextClass,
  rowTitleClass,
  ruledRowClass,
} from "../ui";
import { CloudLine } from "./CloudLine";

/**
 * Under "Transcribe on" in Settings › Meetings (#141). Before a cloud service is chosen it says
 * what choosing one sends, so the choice is the consent (ADR-0022); once chosen, where the audio
 * goes and what it costs, or that Local mode holds it back.
 */
export function TranscriptionRouteLine({ id }: { id?: string }) {
  const t = useT();
  const language = useLanguage();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? "local";
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const services = useTranscriptionServicesList();
  const service = services.find((each) => each.route === route);
  if (!service) {
    return (
      <p id={id} data-testid="meetings-route-line" className={rowTextClass}>
        {t(
          services.some((each) => each.hasKey)
            ? "meetings.route.consent"
            : "meetings.route.hereLine",
        )}
      </p>
    );
  }
  return (
    <div id={id} data-testid="meetings-route-line" className="flex flex-col gap-0.5">
      <p className="text-[13px] leading-5 text-ink-meta tabular-nums">
        {serviceMeta(service, t, language)}
      </p>
      {localMode ? (
        <p className={rowTextClass}>{t("meetings.route.paused")}</p>
      ) : (
        <CloudLine service={service} className={rowTextClass} />
      )}
    </div>
  );
}

/**
 * Where a job list offers the Meetings choice (first run, Settings › Models): before a cloud
 * service is chosen, what choosing one sends, so the choice is the consent (ADR-0022); after,
 * where the audio goes. Nothing while no service has a key, as nothing else is offered.
 */
export function TranscriptionRouteConsent() {
  const t = useT();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? "local";
  const services = useTranscriptionServicesList();
  const service = services.find((each) => each.route === route);
  if (!service && !services.some((each) => each.hasKey)) return null;
  if (!service) {
    return (
      <p data-testid="meetings-route-consent" className="text-[12px] leading-5 text-ink-meta">
        {t("meetings.route.consent")}
      </p>
    );
  }
  return (
    <CloudLine
      service={service}
      testId="meetings-route-consent"
      className="text-[12px] leading-5 text-ink-meta"
    />
  );
}

/** A transcription service's own key (Soniox's): pasted, checked with the service, kept in the keychain. */
export function TranscriptionKeyRows() {
  const services = useTranscriptionServicesList();
  return (
    <>
      {services
        .filter((service) => service.key === "own")
        .map((service) => (
          <TranscriptionKeyRow key={service.route} service={service} />
        ))}
    </>
  );
}

function TranscriptionKeyRow({ service }: { service: TranscriptionServiceStatus }) {
  const t = useT();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  useEffect(() => {
    core
      .getSecretStorage()
      .then(setStorage, (error: unknown) =>
        console.error("The keychain's state couldn't be read.", error),
      );
  }, []);
  const acceptPlainText = async () => {
    try {
      setStorage(await core.acceptPlainTextSecretStorage());
    } catch (error) {
      setProblem(errorMessage(error, t));
    }
  };
  const [key, setKey] = useState("");
  const { key: text, stray } = checkApiKey(key);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = { provider: t(ROUTE_LABELS[service.route]) };
  const save = async () => {
    setSaving(true);
    const failed = await useTranscriptionServices.getState().setKey(service.route, key);
    setSaving(false);
    setProblem(failed);
    if (!failed) {
      setKey("");
      setOpen(false);
    }
  };

  return (
    <div data-testid={`transcription-key-${service.route}`} className={ruledRowClass}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={inputId} className={rowTitleClass}>
          {t("meetings.key.title", name)}
        </label>
        <p className={rowTextClass}>
          {t("meetings.key.line", name)}
          {service.keyUrl && (
            <>
              {" "}
              <a
                href={service.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-rule-strong underline-offset-2 hover:text-ink"
              >
                {t("meetings.key.get")}
              </a>
            </>
          )}
        </p>
        {open && (
          <form
            className="mt-1.5 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (text !== "" && !stray && !saving) void save();
            }}
          >
            <input
              id={inputId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              // biome-ignore lint/a11y/noAutofocus: it opens only when the User asks to add a key.
              autoFocus
              data-testid="transcription-key-input"
              placeholder={t("meetings.key.placeholder")}
              aria-invalid={stray ? true : undefined}
              aria-describedby={stray ? `${inputId}-stray` : undefined}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setOpen(false);
                  setKey("");
                }
              }}
              className={`${inputClass} mt-0 min-w-48 flex-1`}
            />
            <button
              type="submit"
              data-testid="transcription-key-save"
              disabled={
                text === "" || stray !== null || saving || (storage !== null && !storage.canSave)
              }
              className={buttonStyle("primary")}
            >
              {t(saving ? "meetings.key.checking" : "meetings.key.save")}
            </button>
          </form>
        )}
        {open && stray && <KeyCharacterLine id={`${inputId}-stray`} stray={stray} />}
        {open && storage && !storage.canSave && (
          <SecretStorageNotice status={storage} onAccept={() => void acceptPlainText()} />
        )}
        {problem && (
          <ProblemLine className="mt-1" testId="transcription-key-problem">
            {problem}
          </ProblemLine>
        )}
      </div>
      {!open && (
        <div className={rowButtonsClass}>
          {service.hasKey && (
            <span data-testid="transcription-key-saved" className={rowStatusClass}>
              {t("meetings.key.saved")}
            </span>
          )}
          <button
            type="button"
            data-testid="transcription-key-add"
            onClick={() => {
              setProblem(null);
              setOpen(true);
            }}
            className={buttonStyle("secondary")}
          >
            {t(service.hasKey ? "meetings.key.replace" : "meetings.key.add")}
          </button>
          {service.hasKey && (
            <button
              type="button"
              data-testid="transcription-key-remove"
              onClick={() =>
                void useTranscriptionServices.getState().removeKey(service.route).then(setProblem)
              }
              className={buttonStyle("ghost")}
            >
              {t("meetings.key.remove")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
