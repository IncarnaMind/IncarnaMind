import { useEffect, useId, useState } from "react";
import type { SecretStorageStatus, TranscriptionServiceStatus } from "../../../../core/api";
import { checkApiKey } from "../../../../shared/apiKey";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  ROUTE_LABELS,
  type ServicesView,
  serviceMeta,
  useTranscriptionServices,
} from "../../transcriptionServices";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemLine } from "../ProblemLine";
import { KeyNotCheckedLine, SecretStorageNotice } from "../providers/ProviderForm";
import { ReadProblem } from "../ReadProblem";
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
import { LanguagesLine } from "./LanguagesLine";

/**
 * Under "Transcribe on" in Settings › Meetings (#141). Before a cloud service is chosen it says
 * what choosing one sends, so the choice is the consent (ADR-0022); once chosen, where the audio
 * goes and what it costs, or that Local mode holds it back.
 */
export function TranscriptionRouteLine({ id, read }: { id?: string; read: ServicesView }) {
  const t = useT();
  const language = useLanguage();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? "local";
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  // A list that couldn't be read says nothing of where the audio goes: the saved route stands.
  if (read.state === "failed") {
    return (
      <div id={id} data-read-host>
        <ReadProblem
          words={t("setup.services.failed")}
          read={read}
          testId="meetings-route-problem"
        />
      </div>
    );
  }
  const services = read.state === "ready" ? read.data : [];
  const service = services.find((each) => each.route === route);
  if (!service) {
    return (
      <p id={id} data-testid="meetings-route-line" className={rowTextClass}>
        {chooseAgainLine(services, t, language) ??
          t(
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
      <LanguagesLine service={service} className={rowTextClass} />
    </div>
  );
}

/**
 * Where a job list offers the Meetings choice (first run, Settings › Models): before a cloud
 * service is chosen, what choosing one sends, so the choice is the consent (ADR-0022); after,
 * where the audio goes. Nothing while no service has a key, as nothing else is offered.
 */
export function TranscriptionRouteConsent({ read }: { read: ServicesView }) {
  const t = useT();
  const language = useLanguage();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? "local";
  if (read.state === "failed") {
    return (
      <div data-read-host>
        <ReadProblem
          words={t("setup.services.failed")}
          read={read}
          testId="meetings-route-problem"
        />
      </div>
    );
  }
  const services = read.state === "ready" ? read.data : [];
  const service = services.find((each) => each.route === route);
  if (!service && !services.some((each) => each.hasKey)) return null;
  if (!service) {
    return (
      <p data-testid="meetings-route-consent" className="text-[12px] leading-5 text-ink-meta">
        {chooseAgainLine(services, t, language) ?? t("meetings.route.consent")}
      </p>
    );
  }
  return (
    <>
      <CloudLine
        service={service}
        testId="meetings-route-consent"
        className="text-[12px] leading-5 text-ink-meta"
      />
      <LanguagesLine service={service} className="text-[12px] leading-5 text-ink-meta" />
    </>
  );
}

function chooseAgainLine(
  services: readonly TranscriptionServiceStatus[],
  t: ReturnType<typeof useT>,
  language: ReturnType<typeof useLanguage>,
): string | null {
  const service = services.find((each) => each.chooseAgain);
  if (!service) return null;
  const words = language === "zh-CN" ? "zh" : "en";
  return t("meetings.route.chooseAgain", {
    provider: t(ROUTE_LABELS[service.route]),
    region: (service.region ?? service.recipient)[words],
  });
}

/**
 * A transcription service's own key (Soniox's, Deepgram's, AssemblyAI's): pasted, checked with the
 * service, kept in the keychain. Deepgram's takes the server too, where it isn't Deepgram's own:
 * Cloudflare Workers AI's or the User's, whose key may be left out.
 */
export function TranscriptionKeyRows({ read }: { read: ServicesView }) {
  const services = read.state === "ready" ? read.data : [];
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
  const serverId = useId();
  const [open, setOpen] = useState(false);
  const takesServer = service.route === "deepgram";
  const [server, setServer] = useState("");
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
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const [notChecked, setNotChecked] = useState(false);
  const name = { provider: t(ROUTE_LABELS[service.route]) };
  const save = async () => {
    setSaving(true);
    const unchecked = localMode && service.keyChecked && text !== "";
    const failed = await useTranscriptionServices
      .getState()
      .setKey(service.route, key, takesServer ? server : undefined);
    setSaving(false);
    setProblem(failed);
    if (!failed) {
      setKey("");
      setOpen(false);
      setNotChecked(unchecked);
    }
  };
  const close = () => {
    setOpen(false);
    setKey("");
  };
  const given = text !== "" || (takesServer && server.trim() !== "");

  return (
    <div data-testid={`transcription-key-${service.route}`} className={ruledRowClass}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={inputId} className={rowTitleClass}>
          {t("meetings.key.title", name)}
        </label>
        <p className={rowTextClass}>
          {t(
            service.keyChecked && !localMode ? "meetings.key.lineChecked" : "meetings.key.line",
            name,
          )}
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
        {service.server && !open && (
          <p data-testid="transcription-key-server-saved" className={`${rowTextClass} break-words`}>
            {t("meetings.key.serverSaved", { server: service.server })}
          </p>
        )}
        {open && takesServer && (
          <div className="mt-1.5 flex flex-col gap-1">
            <label htmlFor={serverId} className="text-[13px] leading-5 text-ink">
              {t("meetings.key.server")}
            </label>
            <input
              id={serverId}
              type="url"
              autoComplete="off"
              spellCheck={false}
              data-testid="transcription-key-server"
              placeholder={t("meetings.key.serverPlaceholder")}
              aria-describedby={`${serverId}-tip`}
              value={server}
              onChange={(event) => setServer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  close();
                }
              }}
              className={`${inputClass} mt-0 min-w-48`}
            />
            <p id={`${serverId}-tip`} className={rowTextClass}>
              {t("meetings.key.serverTip")}
            </p>
          </div>
        )}
        {open && (
          <form
            className="mt-1.5 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (given && !stray && !saving) void save();
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
                  close();
                }
              }}
              className={`${inputClass} mt-0 min-w-48 flex-1`}
            />
            <button
              type="submit"
              data-testid="transcription-key-save"
              disabled={
                !given || stray !== null || saving || (storage !== null && !storage.canSave)
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
        {notChecked && !open && <KeyNotCheckedLine provider={name.provider} />}
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
              setNotChecked(false);
              setServer(service.server ?? "");
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
