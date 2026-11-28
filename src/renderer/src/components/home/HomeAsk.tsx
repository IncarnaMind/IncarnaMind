import { type KeyboardEvent, useState } from "react";
import { type AgentPairing, ALL_SHARED_ID } from "../../../../core/api";
import {
  askFirstAgent,
  useAgentsToAskRead,
  useNoModel,
  useOwnAiRunsHere,
  useReadAgentsToAsk,
} from "../../askYourAi";
import { menuKeysLabel } from "../../commands/keymap";
import { commands } from "../../commands/registry";
import { core } from "../../core";
import { withKeys } from "../../editor/withShortcut";
import { useT } from "../../i18n";
import { askInNote } from "../../ownAiInNote";
import { runsInBackground } from "../../ownAiPanel";
import { useAppStore } from "../../store";
import { AskArrowIcon } from "../icons";
import { NewMenu } from "../NewMenu";
import { ProblemLine } from "../ProblemLine";
import { TypingTextarea } from "../TypingTextarea";
import { buttonStyle } from "../ui";

/**
 * The connected AI apps that may read a Note Home starts, which is in no Folder: those given all of
 * the User's Documents and Notes. One given chosen Folders, or Not in a Folder, reads only the
 * Notes in those Folders and those it wrote itself (`pairingReaches` in src/core/agents/access.ts).
 */
const newNoteReaders = (agents: readonly AgentPairing[]) =>
  agents.filter((each) => each.folderIds.includes(ALL_SHARED_ID));

/**
 * The Note made for an ask that never went: the User didn't make it, so none of it waits in
 * Recently deleted.
 */
async function discardNote(mindId: string): Promise<void> {
  await core.deleteMind(mindId);
  await core.deletePermanently([{ kind: "mind", id: mindId }]);
}

/**
 * Home's one input and its three ways to start (#3791): asking there starts a Note in no Folder and
 * asks the User's own AI in it, as its own input does; with none that may read a new note, one line
 * says so, as a Note's own input does. The words stay until the ask has gone; the Note opens then.
 * Add files…, Link a folder… and New note sit under it. With no AI app connected and no model set
 * up there is no input that can't answer (#3767): Add files… is the one black button while Home is
 * empty, and while Home is `starting` one line under the buttons says to connect an AI; once it
 * has Notes, the line stands at Home's foot (`HomeFootConnect`).
 */
export function HomeAsk({ starting, empty }: { starting: boolean; empty: boolean }) {
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
  // An ask the core found no AI to read, though one seemed to: said as when none may, the words kept.
  const [refused, setRefused] = useState(false);
  const newMind = commands.get("mind.new");
  const newMindKeys = newMind ? menuKeysLabel(newMind) : null;
  const readers = agents ? newNoteReaders(agents) : null;
  const agent = readers?.find((each) => runsInBackground(each, runsHere)) ?? readers?.[0] ?? null;
  const cantRead = agents !== null && agents.length > 0 && (refused || agent === null);
  const noAi = agents !== null && agents.length === 0 && noModel;
  const placeholder = agent ? t("home.ask.placeholder", { agent: agent.name }) : "";

  const send = async () => {
    const typed = words.trim();
    if (typed === "" || sending || !agent) return;
    setSending(true);
    const store = useAppStore.getState();
    let mindId: string | null = null;
    try {
      mindId = (await core.createMind()).id;
      const went = runsInBackground(agent, runsHere)
        ? await askInNote(mindId, { words: typed, quote: "", selection: null, caret: "" })
        : "link";
      // Started, or stopped with its problem: either way it is the Note's now, which shows it
      // with the question, as its own input does.
      const asked =
        went === "link" ? await askFirstAgent(mindId, { kind: "question", text: typed }) : went;
      if (asked === "none" || asked === "failed") {
        // Nothing went: the empty Note goes, and the words stay here to send again. Why is said
        // here: no AI may read the new note, or the failure's own notice.
        await discardNote(mindId);
        if (asked === "none") setRefused(true);
        return;
      }
      store.openMind(mindId);
      setWords("");
    } catch (error) {
      if (mindId) await discardNote(mindId).catch(store.reportError);
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
      {agent && (
        <div className="flex items-end gap-2 rounded-[22px] bg-sheet py-2 pr-2 pl-[18px] shadow-[inset_0_0_0_1px_var(--color-rule-strong),0_1px_3px_var(--color-shadow-soft)] focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)]">
          <TypingTextarea
            data-testid="home-ask-input"
            aria-label={placeholder}
            placeholder={placeholder}
            rows={1}
            value={words}
            onChange={(event) => {
              setWords(event.target.value);
              setRefused(false);
            }}
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
            <AskArrowIcon />
          </button>
        </div>
      )}
      {cantRead && agents && (
        <ProblemLine
          role="status"
          testId="home-ask-cant-read"
          action={{
            label: t("meetings.notesAgent.settings"),
            testId: "home-ask-settings",
            onClick: () => openSettings("ai"),
          }}
        >
          {agents.length === 1 && agents[0]
            ? t("home.ask.cantRead.one", { agent: agents[0].name })
            : t("home.ask.cantRead")}
        </ProblemLine>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="home-add-files"
          onClick={() => void pickDocuments()}
          className={buttonStyle(noAi && empty ? "primary" : "secondary")}
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
      {noAi && starting && <ConnectLine testId="home-ask" />}
    </section>
  );
}

/** "Asking needs your AI · Connect your AI", as a Note's foot says it (#3764). */
function ConnectLine({ testId }: { testId: string }) {
  const t = useT();
  const openSettings = useAppStore((state) => state.openSettings);
  return (
    <ProblemLine
      role="status"
      testId={`${testId}-no-ai`}
      action={{
        label: t("agents.install.connectYourAi"),
        testId: `${testId}-connect`,
        onClick: () => openSettings("ai"),
      }}
    >
      {t("noteAsk.noAi")}
    </ProblemLine>
  );
}

/** Home's foot once it has Notes, with no AI app connected and no model: the line to connect one. */
export function HomeFootConnect() {
  useReadAgentsToAsk(null);
  const agents = useAgentsToAskRead(null);
  const noModel = useNoModel();
  if (agents === null || agents.length > 0 || !noModel) return null;
  return (
    <div data-testid="home-foot-ask" className="note-foot-ask px-6">
      <ConnectLine testId="home-foot" />
    </div>
  );
}
