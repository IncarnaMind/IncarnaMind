import { type ReactNode, useEffect, useId, useState } from "react";
import type { ChatProvider, TranscriptionRoute } from "../../../../core/api";
import { continueSetup } from "../../conversations";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { giveUpWaiting } from "../../modelSetup";
import { useAppStore } from "../../store";
import { useTranscriptionServicesList } from "../../transcriptionServices";
import { CheckLineIcon } from "../lineIcons";
import { TranscriptionRouteSelect } from "../meetings/TranscriptionRouteSelect";
import { TranscriptionRouteConsent } from "../meetings/TranscriptionSettings";
import { buttonStyle, fieldClass, hintClass } from "../ui";
import { CHATGPT_RECIPIENT } from "./ChatGptSignIn";
import { providerName } from "./ProviderPage";
import { SendsLine } from "./SendsLine";
import { SortingLine, SortingSelect, useSorting } from "./SortingChoice";

const linkClass =
  "text-[13px] leading-5 font-semibold text-accent underline-offset-2 hover:underline";

function recipientOf(provider: ChatProvider, name: string): string | null {
  // A server on this computer sends nothing anywhere, whatever it is called.
  if (provider.service === null) return null;
  if (provider.kind === "chatgpt") return CHATGPT_RECIPIENT;
  if (provider.kind === "claude-account") return "Anthropic";
  if (provider.kind === "copilot") return "GitHub";
  return name;
}

/**
 * Once a model works (#1922), steps 2 and 3 stay while their Answer runs above: meeting
 * transcription, best left on this computer, and what sorts Documents and names meeting hints.
 * Each is one click, skippable, and its choice is the consent for its flow (ADR-0022).
 */
export function SetupSteps() {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const user = useAppStore((state) => state.settings?.user);
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  const [done, setDone] = useState({ transcription: false, sorting: false });

  useEffect(() => {
    core.listChatProviders().then(setProviders, (error: unknown) => {
      console.error("The saved chat providers couldn't be listed for the setup card.", error);
    });
  }, []);
  useEffect(() => {
    if (done.transcription && done.sorting) continueSetup();
  }, [done]);

  const chosen = user?.chatModel;
  const provider = providers.find((each) => each.id === chosen?.providerId);
  const name = provider ? providerName(provider, t, language) : null;
  const recipient = provider && name ? recipientOf(provider, name) : null;

  return (
    <section
      data-testid="model-setup"
      aria-labelledby={`${id}-title`}
      className="setup-card flex min-h-0 max-h-[85vh] flex-col gap-2.5 overflow-y-auto px-4"
    >
      <h2
        id={`${id}-title`}
        data-setup-title
        data-testid="setup-ready-title"
        className="flex items-center gap-2 text-[15px] leading-6 font-semibold text-ink"
      >
        <CheckLineIcon className="size-4 shrink-0 text-ink" />
        {name ? t("setup.ready", { name }) : t("setup.ready.generic")}
      </h2>
      {recipient && <SendsLine provider={recipient} testId="setup-ready-sends" />}
      <ol className="flex flex-col gap-3">
        <Step
          number={2}
          title={t("setup.step.transcription")}
          testId="transcription"
          done={done.transcription}
        >
          <TranscriptionStep onDone={() => setDone((each) => ({ ...each, transcription: true }))} />
        </Step>
        <Step number={3} title={t("setup.step.sorting")} testId="sorting" done={done.sorting}>
          <SortingStep
            autoFocus={done.transcription}
            onDone={() => setDone((each) => ({ ...each, sorting: true }))}
          />
        </Step>
      </ol>
      <div data-setup-foot>
        <button
          type="button"
          data-testid="setup-later"
          onClick={giveUpWaiting}
          className="-ml-2 text-[13px] leading-5 font-semibold text-accent underline-offset-2 hover:underline"
        >
          {t("providers.setup.later")}
        </button>
      </div>
    </section>
  );
}

function Step({
  number,
  title,
  testId,
  done,
  children,
}: {
  number: number;
  title: string;
  testId: string;
  done: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <li
      data-testid={`setup-step-${testId}`}
      data-done={done || undefined}
      className="flex flex-col gap-2"
    >
      <h3 className="flex items-center gap-2.5 text-[14px] leading-5 font-semibold text-ink">
        {done ? (
          <span
            aria-hidden="true"
            className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-success text-white"
          >
            <CheckLineIcon className="size-2.5" />
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-ink text-[10px] leading-none font-bold text-white"
          >
            {number}
          </span>
        )}
        {title}
        {done && <span className="sr-only">{t("gettingStarted.done")}</span>}
      </h3>
      {!done && <div className="flex flex-col gap-2 pl-7">{children}</div>}
    </li>
  );
}

/**
 * Where a Meeting's audio is transcribed (#141): this computer, free and private, unless a key
 * already serves a cloud service. Choosing one there is the consent to send it the audio.
 */
function TranscriptionStep({ onDone }: { onDone(): void }) {
  const t = useT();
  const id = useId();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const saved = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? null;
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openSettings = useAppStore((state) => state.openSettings);
  const services = useTranscriptionServicesList();
  const cloudy = services.filter((service) => service.hasKey);
  const [picked, setPicked] = useState<TranscriptionRoute | null>(null);
  const route = localOnly ? "local" : (picked ?? saved ?? "local");
  const service = services.find((each) => each.route === route);
  const use = async () => {
    await updateSettings({ device: { transcriptionRoute: route } });
    onDone();
  };
  return (
    <>
      <TranscriptionRouteSelect
        id={`${id}-route`}
        className={fieldClass}
        localOnly={localOnly}
        saveOnChange={false}
        focusOnShow
        testId="setup-transcription"
        onChosen={setPicked}
      />
      <p data-testid="setup-transcription-line" className={hintClass}>
        {service
          ? t("meetings.route.cloudLine", { service: service.name })
          : t("setup.step.transcription.line")}
      </p>
      {/* Before a cloud route is chosen, what choosing one sends (ADR-0022). */}
      {!localOnly && <TranscriptionRouteConsent />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          data-testid="setup-transcription-use"
          onClick={() => void use()}
          className={buttonStyle("primary", "sm")}
        >
          {t("setup.step.useThis")}
        </button>
        <button
          type="button"
          data-testid="setup-transcription-later"
          onClick={onDone}
          className={linkClass}
        >
          {t("setup.step.laterRecord")}
        </button>
        {!localOnly && cloudy.length === 0 && (
          <button
            type="button"
            data-testid="setup-transcription-add-key"
            onClick={() => openSettings("meetings")}
            className={linkClass}
          >
            {t("setup.step.addKey")}
          </button>
        )}
      </div>
    </>
  );
}

/** What sorts Tags and Folders and names meeting hints, the best the keys reach picked first. */
function SortingStep({ onDone, autoFocus }: { onDone(): void; autoFocus: boolean }) {
  const t = useT();
  const { options, current, choose } = useSorting();
  const [picked, setPicked] = useState<SortingOptionLike | null>(null);
  const chosen = picked ?? current;
  const use = async () => {
    if (chosen && !(await choose(chosen))) return;
    onDone();
  };
  return (
    <>
      <SortingSelect
        id="setup-sorting"
        autoFocus={autoFocus}
        options={options}
        current={chosen}
        onChange={setPicked}
      />
      <SortingLine option={chosen} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          data-testid="setup-sorting-use"
          disabled={chosen === null}
          onClick={() => void use()}
          className={buttonStyle("primary", "sm")}
        >
          {t("setup.step.useThis")}
        </button>
        <button
          type="button"
          data-testid="setup-sorting-skip"
          onClick={onDone}
          className={linkClass}
        >
          {t("setup.step.skip")}
        </button>
      </div>
    </>
  );
}

type SortingOptionLike = ReturnType<typeof useSorting>["options"][number];
