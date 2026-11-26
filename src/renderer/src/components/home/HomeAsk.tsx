import { type KeyboardEvent, useState } from "react";
import {
  askFirstAgent,
  useAgentsToAskRead,
  useNoModel,
  useOwnAiRunsHere,
  useReadAgentsToAsk,
} from "../../askYourAi";
import { menuKeysLabel } from "../../commands/keymap";
import { commands } from "../../commands/registry";
import { AskArrowIcon } from "../../editor/icons";
import { withKeys } from "../../editor/withShortcut";
import { useT } from "../../i18n";
import { askInNote } from "../../ownAiInNote";
import { runsInBackground } from "../../ownAiPanel";
import { useAppStore } from "../../store";
import { NewMenu } from "../NewMenu";
import { ProblemLine } from "../ProblemLine";
import { TypingTextarea } from "../TypingTextarea";
import { buttonStyle } from "../ui";

/**
 * Home's one input and its three ways to start (#3791): asking there starts a Note and asks the
 * User's own AI in it, as its own input does; with no AI app connected and no model set up, one
 * line says to connect one (with a model, Home's next step asks it). Add files…, Link a folder…
 * and New note sit under it.
 */
export function HomeAsk() {
  const t = useT();
  useReadAgentsToAsk(null);
  const agents = useAgentsToAskRead(null);
  const noModel = useNoModel();
  const runsHere = useOwnAiRunsHere();
  const pickDocuments = useAppStore((state) => state.pickDocuments);
  const addLinkedFolder = useAppStore((state) => state.addLinkedFolder);
  const openSettings = useAppStore((state) => state.openSettings);
  const [words, setWords] = useState("");
  const [sending, setSending] = useState(false);
  const newMind = commands.get("mind.new");
  const newMindKeys = newMind ? menuKeysLabel(newMind) : null;
  const agent = agents?.find((each) => runsInBackground(each, runsHere)) ?? agents?.[0] ?? null;
  const placeholder = agent ? t("home.ask.placeholder", { agent: agent.name }) : "";

  const send = async () => {
    const typed = words.trim();
    if (typed === "" || sending || !agent) return;
    setSending(true);
    const store = useAppStore.getState();
    try {
      const mindId = await store.createMind();
      if (!mindId) return;
      setWords("");
      const went = runsInBackground(agent, runsHere)
        ? await askInNote(mindId, { words: typed, quote: "", selection: null, caret: "" })
        : "link";
      if (went === "link") await askFirstAgent(mindId, { kind: "question", text: typed });
    } catch (error) {
      setWords(typed);
      store.reportError(error);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <section data-testid="home-ask" className="mb-8 flex flex-col gap-3">
      {agents === null ? null : agent ? (
        <div className="flex items-end gap-2 rounded-[22px] bg-sheet py-2 pr-2 pl-[18px] shadow-[inset_0_0_0_1px_var(--color-rule-strong),0_1px_3px_var(--color-shadow-soft)] focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)]">
          <TypingTextarea
            data-testid="home-ask-input"
            aria-label={placeholder}
            placeholder={placeholder}
            rows={1}
            value={words}
            onChange={(event) => setWords(event.target.value)}
            onKeyDown={onKeyDown}
            className="max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1 text-ui text-ink outline-none [field-sizing:content] placeholder:text-ink-placeholder"
          />
          <button
            type="button"
            data-testid="home-ask-send"
            aria-label={t("noteAsk.send")}
            title={t("noteAsk.send")}
            disabled={words.trim() === "" || sending}
            onClick={() => void send()}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-on-primary disabled:bg-chip disabled:text-ink-meta"
          >
            <AskArrowIcon className="size-3" />
          </button>
        </div>
      ) : !noModel ? null : (
        <ProblemLine
          role="status"
          testId="home-ask-no-ai"
          action={{
            label: t("noteAsk.connect"),
            testId: "home-ask-connect",
            onClick: () => openSettings("ai"),
          }}
        >
          {t("noteAsk.connectToAsk")}
        </ProblemLine>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="home-add-files"
          onClick={() => void pickDocuments()}
          className={buttonStyle("secondary")}
        >
          {t("startGuide.documents.addFiles")}
        </button>
        <button
          type="button"
          data-testid="home-link-folder"
          onClick={() => void addLinkedFolder()}
          className={buttonStyle("secondary")}
        >
          {t("startGuide.documents.linkFolder")}
        </button>
        <span className="flex">
          <button
            type="button"
            data-testid="home-new-mind"
            title={withKeys(t, t("menu.newMind"), newMindKeys)}
            onClick={() => void commands.run("mind.new").catch(useAppStore.getState().reportError)}
            className={`${buttonStyle("secondary")} rounded-r-none`}
          >
            {t("menu.newMind")}
          </button>
          <NewMenu place="home" />
        </span>
      </div>
    </section>
  );
}
