import { useEffect, useRef, useState } from "react";
import type { AgentClient, ChatProvider } from "../../../../core/api";
import { SHOW_AGENT_CONNECTION } from "../../../../shared/agentConnection";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { giveUpWaiting, useModelSetup } from "../../modelSetup";
import { useAppStore } from "../../store";
import { ChevronRightLineIcon, KeyLineIcon } from "../lineIcons";
import { ProblemLine } from "../ProblemLine";
import { buttonStyle, hintClass } from "../ui";
import { ChatGptMark } from "./ChatGptMark";
import {
  CHATGPT_RECIPIENT,
  ChatGptSignInState,
  ChatGptStorageNotice,
  useChatGptStorage,
  useContinueWithChatGpt,
} from "./ChatGptSignIn";
import { ClaudePlanWay } from "./ClaudePlan";
import { CopilotSetupWay } from "./CopilotPlan";
import {
  OllamaAction,
  OllamaProgress,
  type Ollama as OllamaState,
  ollamaDescription,
  useOllama,
} from "./OllamaCard";
import { ProviderForm } from "./ProviderForm";
import { SendsLine } from "./SendsLine";
import { SetupReady } from "./SetupReady";

const CLAUDE_DOWNLOAD = "https://claude.ai/download";

type View = "key" | "local" | null;

/**
 * The first own Question with no model set (#103, D198): the assistant's composer becomes this
 * card while the Question waits above it. Two ways lead, the same size: the ChatGPT plan and a
 * key (#890); in Chinese the key comes first and opens on DeepSeek. The rest are folded under
 * "Other ways", and Set up later is last. Choosing a service is the consent for it (#718), so no
 * dialog is added here.
 */
export function ModelSetupCard() {
  return useModelSetup((state) => state.ready) ? <SetupReady /> : <ChooseAnAi />;
}

function ChooseAnAi() {
  const t = useT();
  const chinese = useLanguage() === "zh-CN";
  const [view, setView] = useState<View>(null);
  const [others, setOthers] = useState(false);
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  const ollama = useOllama(() => undefined);
  const sign = useContinueWithChatGpt({ onSignedIn: () => undefined });
  useEffect(() => {
    // Only to tell the form a key is already saved: the form works with none listed.
    core
      .listChatProviders()
      .then(setProviders, (error: unknown) =>
        console.error("The saved chat providers couldn't be listed for the setup card.", error),
      );
  }, []);
  const running = ollama.status?.running;
  const card = useRef<HTMLElement>(null);
  const previousView = useRef<View>(null);
  // It takes the composer's place, or opens from the steps card: either way the focus comes in.
  useEffect(() => {
    if (view === null) {
      const back = previousView.current;
      const choice = back ? `[data-setup-view="${back}"]` : "[data-setup-choice]:not(:disabled)";
      card.current?.querySelector<HTMLButtonElement>(choice)?.focus();
    }
    previousView.current = view;
  }, [view]);

  return (
    <section
      ref={card}
      data-testid="model-setup"
      aria-labelledby="model-setup-title"
      className="setup-card flex min-h-0 max-h-[85vh] flex-col gap-2.5 overflow-y-auto px-4"
    >
      <h2
        id="model-setup-title"
        data-setup-title={view === null ? true : undefined}
        className={view === null ? "text-[15px] leading-6 font-semibold text-ink" : "sr-only"}
      >
        {t("setup.title")}
      </h2>

      {view === null ? (
        <>
          {sign.waiting ? (
            <ChatGptSignInState sign={sign} />
          ) : (
            <>
              <LeadingWays chinese={chinese} sign={sign} onKey={() => setView("key")} />
              <ChatGptSignInState sign={sign} />
            </>
          )}
          <details
            open={others}
            onToggle={(event) => setOthers(event.currentTarget.open)}
            className="flex flex-col gap-2"
          >
            <summary
              data-testid="setup-other"
              className="cursor-default text-[13px] leading-5 font-semibold text-ink-secondary"
            >
              {t("setup.other")}
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <ClaudePlanWay onUseKey={() => setView("key")} />
              <CopilotSetupWay onKey={() => setView("key")} />
              <Way
                testId="way-local"
                view="local"
                title={t("setup.way.local")}
                line={t(
                  running === undefined
                    ? "setup.way.local.line"
                    : running
                      ? "setup.way.local.running"
                      : "setup.way.local.notRunning",
                )}
                onClick={() => {
                  setOthers(true);
                  setView("local");
                }}
                {...(!running && {
                  link: { label: t("setup.getOllama"), href: "https://ollama.com/download" },
                })}
              />
              {/* Connecting the Claude app needs the agent connection, which is off (#882). */}
              {SHOW_AGENT_CONNECTION && !chinese && <ClaudeWay />}
            </div>
          </details>
        </>
      ) : (
        <>
          <button
            type="button"
            data-testid="setup-back"
            onClick={() => setView(null)}
            className="self-start text-[13px] font-semibold text-accent underline-offset-2 hover:underline"
          >
            ‹ {t("setup.back")}
          </button>
          {view === "key" && (
            <ProviderForm providers={providers} onSaved={() => undefined} standalone />
          )}
          {view === "local" && <LocalWay ollama={ollama} />}
        </>
      )}

      <div>
        <button
          type="button"
          data-testid="setup-later"
          onClick={giveUpWaiting}
          className={`-ml-3 ${buttonStyle("ghost", "md")}`}
        >
          {t("providers.setup.later")}
        </button>
      </div>
    </section>
  );
}

function LeadingWays({
  chinese,
  sign,
  onKey,
}: {
  chinese: boolean;
  sign: ReturnType<typeof useContinueWithChatGpt>;
  onKey(): void;
}) {
  const t = useT();
  const storage = useChatGptStorage();
  const lineClass = "text-[12px] leading-[18px] text-ink-meta";
  const plan = (
    <div key="plan" className="flex min-w-0 flex-col gap-1">
      <ChatGptStorageNotice storage={storage} />
      <button
        type="button"
        data-testid="setup-chatgpt"
        data-setup-choice
        disabled={!storage.canSave}
        onClick={() => void sign.run()}
        className={`w-full ${buttonStyle(chinese ? "secondary" : "primary", "lg")}`}
      >
        <ChatGptMark className="size-4" />
        {t("setup.chatgpt.use")}
      </button>
      <p data-testid="setup-chatgpt-line" className={lineClass}>
        {t(chinese ? "setup.chatgpt.line.china" : "setup.chatgpt.line")}
      </p>
      {/* It signs in at once, so it says here what goes to OpenAI (ADR-0022). */}
      <SendsLine provider={CHATGPT_RECIPIENT} testId="setup-chatgpt-sends" />
    </div>
  );
  const key = (
    <div key="key" className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        data-testid="setup-key"
        data-setup-choice
        data-setup-view="key"
        onClick={onKey}
        className={`w-full ${buttonStyle(chinese ? "primary" : "secondary", "lg")}`}
      >
        <KeyLineIcon className="size-4" />
        {t("setup.key.use")}
      </button>
      <p data-testid="setup-key-for" className={`${lineClass} text-balance`}>
        {t("setup.key.for")}
      </p>
    </div>
  );
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
      {/* A DeepSeek key is the recommended way in Chinese. */}
      {chinese ? [key, plan] : [plan, key]}
    </div>
  );
}

function Way({
  testId,
  view,
  title,
  line,
  onClick,
  link,
}: {
  testId: string;
  /** The view the row opens, so Back can return the focus to it. */
  view?: Exclude<View, null>;
  title: string;
  line: string;
  onClick(): void;
  /** A link under the words (How do I get one?, Get Ollama), which is not the row's own click. */
  link?: { label: string; href?: string; onClick?(): void };
}) {
  return (
    <div className="flex items-center gap-2 rounded-md hover:bg-hover">
      <button
        type="button"
        data-testid={testId}
        data-setup-view={view}
        onClick={onClick}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2 py-1.5 text-left"
      >
        <span className="text-ui font-semibold text-ink">{title}</span>
        <span className="text-[13px] leading-5 text-ink-secondary">{line}</span>
      </button>
      {link &&
        (link.href ? (
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[13px] font-semibold text-accent underline-offset-2 hover:underline"
          >
            {link.label} ↗
          </a>
        ) : (
          <button
            type="button"
            onClick={link.onClick}
            className="shrink-0 text-[13px] font-semibold text-accent underline-offset-2 hover:underline"
          >
            {link.label}
          </button>
        ))}
      <ChevronRightLineIcon aria-hidden="true" className="mr-2 size-3.5 shrink-0 text-ink-meta" />
    </div>
  );
}

function LocalWay({ ollama }: { ollama: OllamaState }) {
  const t = useT();
  return (
    <div className="flex flex-col items-start gap-2 pl-2">
      <p data-testid="ollama-status" className="text-[13px] leading-5 text-ink-secondary">
        {ollamaDescription(ollama, t)}
      </p>
      <OllamaProgress ollama={ollama} />
      <OllamaAction ollama={ollama} />
    </div>
  );
}

function ClaudeWay() {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const showPage = useAppStore((state) => state.showSettingsPage);
  const [client, setClient] = useState<AgentClient | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<"copy" | "connected" | null>(null);
  // Only the Folder of the Mind the Question was asked from is shared.
  const folderId = useAppStore((state) => {
    const mindId = useModelSetup.getState().waiting?.mindId;
    return state.minds.find((mind) => mind.id === mindId)?.folderId ?? null;
  });
  useEffect(() => {
    core.listAgentClients().then(
      (all) => setClient(all.find((each) => each.id === "claude-desktop") ?? null),
      (error: unknown) => {
        console.error("The agent list couldn't be read for the setup card.", error);
        setClient(null);
      },
    );
  }, []);
  const connect = async () => {
    if (!folderId) return;
    setBusy(true);
    setProblem(null);
    try {
      await core.setAgentsEnabled(true);
      const { result } = await core.setUpAgent({ client: "claude-desktop", folderIds: [folderId] });
      if (result.kind === "copy") {
        await navigator.clipboard.writeText(result.text).catch(reportError);
        setDone("copy");
      } else setDone("connected");
    } catch (error) {
      setProblem(errorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="setup-claude" className="flex flex-col items-start gap-1 px-2 py-1.5">
      <span className="text-ui font-semibold text-ink">{t("setup.claude.title")}</span>
      <span className="text-[13px] leading-5 text-ink-secondary">{t("setup.claude.line")}</span>
      {client?.installed === false ? (
        <>
          <span className={hintClass}>{t("setup.claude.missing")}</span>
          <a
            href={CLAUDE_DOWNLOAD}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("setup.claude.download")} ↗
          </a>
        </>
      ) : done ? (
        <p data-testid="setup-claude-done" role="status" className={hintClass}>
          {t(done === "copy" ? "setup.claude.copied" : "setup.claude.connected")}
        </p>
      ) : folderId ? (
        <button
          type="button"
          data-testid="setup-claude-connect"
          disabled={busy}
          onClick={() => void connect()}
          className={buttonStyle("secondary", "sm")}
        >
          {t("setup.claude.connect")}
        </button>
      ) : (
        <>
          <span data-testid="setup-claude-nofolder" className={hintClass}>
            {t("setup.claude.noFolder")}
          </span>
          <button
            type="button"
            onClick={() => showPage("agents")}
            className={buttonStyle("secondary", "sm")}
          >
            {t("setup.claude.openAgents")}
          </button>
        </>
      )}
      {problem && <ProblemLine testId="setup-claude-problem">{problem}</ProblemLine>}
    </div>
  );
}
