import type { MessageKey } from "../../../../shared/i18n";
import { useT } from "../../i18n";
import { ollamaRead } from "../../ollamaRead";
import { OnThisComputer } from "../OnThisComputer";
import { buttonStyle } from "../ui";
import { ChatGptMark } from "./ChatGptMark";
import {
  CHATGPT_RECIPIENT,
  ChatGptSignInState,
  ChatGptStorageNotice,
  useChatGptStorage,
  type useContinueWithChatGpt,
} from "./ChatGptSignIn";
import { OllamaAction, OllamaProgress, type Ollama as OllamaState } from "./OllamaCard";
import { SendsLine } from "./SendsLine";

/**
 * The ChatGPT plan: the first way in for a User with no key, where it can be bought. Used by the
 * composer's setup card and the first run's setup page (#3296).
 */
export function ChatGptPlanWay({
  sign,
  leads,
  label = "setup.chatgpt.use",
}: {
  sign: ReturnType<typeof useContinueWithChatGpt>;
  leads: boolean;
  label?: MessageKey;
}) {
  const t = useT();
  const storage = useChatGptStorage();
  const lineClass = "text-[12px] leading-[18px] text-ink-meta";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ChatGptStorageNotice storage={storage} />
      <button
        type="button"
        data-testid="setup-chatgpt"
        data-setup-choice
        disabled={!storage.canSave}
        onClick={() =>
          void sign.run(
            sign.failure?.kind === "record-unreadable" ? { replaceUnreadable: true } : {},
          )
        }
        className={`w-full ${buttonStyle(leads ? "primary" : "secondary", "lg")}`}
      >
        <ChatGptMark className="size-4" />
        {t(label)}
      </button>
      <p data-testid="setup-chatgpt-line" className={lineClass}>
        {t("setup.chatgpt.line")}
      </p>
      {/* It signs in at once, so it says here what goes to OpenAI (ADR-0022). */}
      <SendsLine provider={CHATGPT_RECIPIENT} testId="setup-chatgpt-sends" />
      <ChatGptSignInState sign={sign} />
    </div>
  );
}

/**
 * A model on this computer (#545): used at once when Ollama runs and has a model, else its app
 * is opened to install one. It says what it costs and that nothing leaves. Before the probe
 * answers it says it is looking; a look that ran out of time, twice, settles to saying it wasn't
 * heard from with Check again, and neither says the app is missing (#2196, #2224).
 */
export function LocalWay({ ollama }: { ollama: OllamaState }) {
  const t = useT();
  const read = ollamaRead(ollama);
  return (
    <div data-testid="way-local" className="flex flex-col items-start gap-1.5 px-2 py-1.5">
      <span className="text-ui font-semibold text-ink">
        {t(read === "not-running" ? "setup.way.local.install" : "setup.way.local")}
      </span>
      <span
        data-testid="ollama-status"
        data-read={read}
        data-looking={read === "looking" || undefined}
        className="text-[13px] leading-5 text-ink-secondary"
      >
        {t(
          read === "looking"
            ? "providers.ollama.checking"
            : read === "no-answer"
              ? "providers.ollama.noAnswer"
              : read === "running"
                ? "setup.way.local.running"
                : "setup.way.local.notRunning",
        )}
      </span>
      <OllamaProgress ollama={ollama} />
      <OllamaAction ollama={ollama} />
      {/* One line in every state, so nothing under it moves when the line below changes. */}
      <p data-testid="setup-local-keeps" className="min-h-[18px] text-[12px] leading-[18px]">
        {/* With a cloud service set up and Local mode off, the click leaves Local mode as it is. */}
        {ollama.status?.running && ollama.keepLocal.checked ? (
          <OnThisComputer>{t("setup.way.local.keeps")}</OnThisComputer>
        ) : (
          <span className="text-ink-meta">{t("setup.way.local.line")}</span>
        )}
      </p>
    </div>
  );
}
