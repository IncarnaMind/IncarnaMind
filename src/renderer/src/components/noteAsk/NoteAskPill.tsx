import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentToolName, NoteCitation } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";

type Translate = ReturnType<typeof useT>;

import { undoAsked, useAskedState } from "../../askedChanges";
import { pendingIn } from "../../editor/proposalReview";
import { resolveProposalsIn } from "../../editWithAi";
import { useT } from "../../i18n";
import { showWaitingChanges } from "../../mindChanges";
import { allowAndAskAgain, firstWordsOf, type NoteAsk } from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { MarkdownBlocks } from "../../viewer/MarkdownBlocks";
import { parseMarkdown } from "../../viewer/markdown";
import { ProblemLine } from "../ProblemLine";

/** What the pill says of each Tool while it runs, with what the call names as `{summary}`. */
const DOING: Partial<Record<AgentToolName, MessageKey>> = {
  read_mind: "noteAsk.doing.read_mind",
  list_minds: "noteAsk.doing.list_minds",
  search: "noteAsk.doing.search",
  read_passages: "noteAsk.doing.read_passages",
  cite: "noteAsk.doing.cite",
  check_citations: "noteAsk.doing.cite",
  propose_changes: "noteAsk.doing.propose_changes",
  create_mind: "noteAsk.doing.create_mind",
  run_analysis: "noteAsk.doing.run_analysis",
  calculate: "noteAsk.doing.run_analysis",
  publish_canvas: "noteAsk.doing.publish_canvas",
  update_canvas: "noteAsk.doing.publish_canvas",
};

/** What the pill says of a call as it starts, before it names what it reads or writes. */
const STARTED: Partial<Record<AgentToolName, MessageKey>> = {
  read_mind: "noteAsk.doing.read_mind.any",
  search: "noteAsk.doing.search.any",
  read_passages: "noteAsk.doing.read_passages.any",
  propose_changes: "noteAsk.doing.propose_changes.any",
  create_mind: "noteAsk.doing.create_mind.any",
};

/** The seconds appear once a request has run this long, as the User's AI app shows them. */
const SECONDS_FROM = 3;

/** The changes the AI made that wait in the Note, as its Accept all takes them. */
export function useWaitingInNote(editor: Editor): number {
  return useEditorState({
    editor,
    selector: ({ editor: current }) =>
      pendingIn(current.state).filter((each) => !each.theirs).length,
  });
}

/** The other Notes it wrote, or left changes waiting in: the one in front has them before the User. */
const elsewhereOf = (ask: NoteAsk, mindId: string) => ({
  made: ask.made.filter((each) => each.mindId !== mindId),
  waiting: ask.waiting.filter((each) => each.mindId !== mindId),
});

const openNote = (mindId: string) => useAppStore.getState().openMind(mindId);

/** A sentence of the line, with the Note it names as a button that opens it. */
function Naming({
  said,
  title,
  onOpen,
}: {
  said: (title: string) => string;
  title: string;
  onOpen(): void;
}) {
  const [before = "", after = ""] = said("\u0000").split("\u0000");
  return (
    <span>
      {before}
      <button
        type="button"
        data-testid="note-ask-open-note"
        onClick={onOpen}
        className="note-ask-pill-name"
      >
        {title}
      </button>
      {after}
    </span>
  );
}

/** What the AI did, in IncarnaMind's words, for a reply that says nothing of it. */
function Facts({ ask, mindId }: { ask: NoteAsk; mindId: string }) {
  const t = useT();
  const { made, waiting } = elsewhereOf(ask, mindId);
  const did: ReactNode[] = [
    ...(ask.changed > 0
      ? [
          t(ask.changed === 1 ? "noteAsk.done.changed.one" : "noteAsk.done.changed.other", {
            count: ask.changed,
          }),
        ]
      : []),
    ...waiting.map((each) => (
      <Naming
        key={`waiting-${each.mindId}`}
        said={(title) =>
          t(each.count === 1 ? "noteAsk.done.waiting.one" : "noteAsk.done.waiting.other", {
            count: each.count,
            title,
          })
        }
        title={each.title}
        onOpen={() => showWaitingChanges(each.mindId)}
      />
    )),
    ...made.map((each) => (
      <Naming
        key={`made-${each.mindId}`}
        said={(title) => t("noteAsk.done.wrote", { title })}
        title={each.title}
        onOpen={() => openNote(each.mindId)}
      />
    )),
  ];
  return (
    <span data-testid="note-ask-facts" className="note-ask-pill-text note-ask-pill-reply">
      {did.length > 0
        ? did.flatMap((each, at) => (at === 0 ? [each] : [" ", each]))
        : t("noteAsk.done.nothing", { agent: ask.agent })}
    </span>
  );
}

/** What a running request is doing, in the AI's own words where it wrote some. */
function doingOf(ask: NoteAsk, t: Translate): string {
  const { doing } = ask;
  if (ask.quiet) return t("noteAsk.pill.quiet", { agent: ask.agent });
  if (doing === null) return t("noteAsk.pill.working");
  if (doing.kind === "thinking") return t("noteAsk.pill.thinking");
  if (doing.kind === "compacting") return t("noteAsk.pill.compacting");
  if (doing.kind === "said") {
    const lines = doing.text
      .split(/\n/)
      .map((line) => firstWordsOf(line))
      .filter(Boolean);
    return lines.at(-1) ?? t("noteAsk.pill.working");
  }
  const key = DOING[doing.tool];
  if (!key) return t("noteAsk.pill.working");
  if (doing.summary === "" && key !== "noteAsk.doing.list_minds" && key !== "noteAsk.doing.cite") {
    // A call as it starts, before it names what it reads or writes.
    const any = STARTED[doing.tool];
    return any ? t(any) : t("noteAsk.pill.working");
  }
  if (doing.tool === "read_passages" && ask.documentsFound > 1) {
    return t("noteAsk.doing.read_passages.of", {
      n: doing.count,
      total: Math.max(ask.documentsFound, doing.count),
      summary: doing.summary,
    });
  }
  if (doing.tool === "read_passages" && doing.count > 1) {
    return t("noteAsk.doing.read_passages.counted", {
      summary: doing.summary,
      count: doing.count,
    });
  }
  return t(key, { summary: doing.summary, agent: ask.agent });
}

/** Seconds since `startedAt`, counting each second while `counting`. */
function useSeconds(startedAt: string | null, counting: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
}

/**
 * The one line above a Note's input (#3677), as the User's AI app shows it: while a request runs, a
 * small line in the middle of what the AI is doing, in its own words where it wrote some, and the
 * seconds since the request; when it ends, a line as wide as the input of its reply's first words,
 * with the one thing to do next at its end. Pressed, the reply opens in the conversation.
 */
export function NoteAskPill({
  ask,
  mindId,
  editor,
  onOpen,
}: {
  ask: NoteAsk;
  mindId: string;
  editor: Editor;
  onOpen(): void;
}) {
  const t = useT();
  const working = ask.state === "working";
  const seconds = useSeconds(ask.startedAt, working);
  if (working) {
    return (
      <div
        data-testid="note-ask-pill"
        data-state="working"
        role="status"
        aria-live="polite"
        className="note-ask-pill"
      >
        <span aria-hidden="true" className="note-ask-dots">
          <span />
          <span />
          <span />
        </span>
        <span data-testid="note-ask-pill-text" className="note-ask-pill-text">
          {doingOf(ask, t)}
        </span>
        {seconds >= SECONDS_FROM && (
          <span data-testid="note-ask-seconds" className="note-ask-pill-time">
            {t("noteAsk.seconds", { count: seconds })}
          </span>
        )}
      </div>
    );
  }
  if (ask.state === "failed") {
    const readOnly = ask.problem === "read-only";
    return (
      <div data-testid="note-ask-pill" data-state="failed" className="note-ask-pill note-ask-end">
        <ProblemLine
          testId="note-ask-problem"
          role={readOnly ? "status" : "alert"}
          className="note-ask-pill-text"
          action={
            readOnly
              ? {
                  label: t("noteAsk.allow"),
                  testId: "note-ask-allow",
                  onClick: () =>
                    void allowAndAskAgain(mindId).catch(useAppStore.getState().reportError),
                }
              : undefined
          }
        >
          {readOnly
            ? t("noteAsk.readOnly", { agent: ask.agent })
            : t(`noteAsk.problem.${ask.problem ?? "failed"}`, {
                agent: ask.agent,
                found: ask.versions?.found ?? "",
                lowest: ask.versions?.lowest ?? "",
              })}
        </ProblemLine>
      </div>
    );
  }
  const words = firstWordsOf(ask.reply);
  return (
    <div data-testid="note-ask-pill" data-state="landed" className="note-ask-pill note-ask-end">
      {words === "" ? (
        <Facts ask={ask} mindId={mindId} />
      ) : (
        <button
          type="button"
          data-testid="note-ask-pill-open"
          onClick={onOpen}
          className="note-ask-pill-text note-ask-pill-reply"
        >
          {words}
        </button>
      )}
      <EndAction ask={ask} mindId={mindId} editor={editor} named={words === ""} />
    </div>
  );
}

/**
 * The one thing to do next, at the line's end: Accept all while its changes wait in the Note; else
 * open the Note it wrote, or left changes waiting in, unless the line names it already; else Undo,
 * while what it changed here can still be undone.
 */
export function EndAction({
  ask,
  mindId,
  editor,
  named,
}: {
  ask: NoteAsk;
  mindId: string;
  editor: Editor;
  named: boolean;
}) {
  const t = useT();
  const waiting = useWaitingInNote(editor);
  const undoable = useAskedState(ask.turnId ?? "", mindId) === "can-undo";
  if (waiting > 0) {
    return (
      <button
        type="button"
        data-testid="note-ask-accept-all"
        onClick={() => resolveProposalsIn(editor, mindId, "all", "accept")}
        className="note-ask-pill-action"
      >
        {t("proposal.acceptAll")}
      </button>
    );
  }
  const { made, waiting: elsewhere } = elsewhereOf(ask, mindId);
  const [wrote] = made;
  const [left] = elsewhere;
  const other = named
    ? undefined
    : wrote
      ? { ...wrote, waits: false }
      : left && { ...left, waits: true };
  if (other) {
    return (
      <button
        type="button"
        data-testid="note-ask-open"
        onClick={() => (other.waits ? showWaitingChanges(other.mindId) : openNote(other.mindId))}
        className="note-ask-pill-action note-ask-pill-open-note"
      >
        {t("noteAsk.open", { title: other.title })}
      </button>
    );
  }
  if (!undoable || ask.turnId === null) return null;
  const { turnId } = ask;
  return (
    <button
      type="button"
      data-testid="note-ask-undo"
      onClick={() => undoAsked(turnId, mindId)}
      className="note-ask-pill-action"
    >
      {t("edit.applied.undo")}
    </button>
  );
}

/** Stands for a Citation chip in the text until the reply is drawn: its number between the two. */
const CHIP_OPEN = "\uE000";
const CHIP_CLOSE = "\uE001";

/**
 * A reply as the AI wrote it: its paragraphs, lists and bold, as the app's other reading surfaces
 * show Markdown, and each Citation IncarnaMind gave its connection as the numbered chip a Note
 * shows (#3677). Any other `[cite:…]` is left out, never drawn as a Citation.
 */
export function Reply({ text, citations }: { text: string; citations: readonly NoteCitation[] }) {
  const t = useT();
  const drawn = useRef<HTMLDivElement>(null);
  const tokens: string[] = [];
  const shown = text.replace(/\s?\[cite:([a-z0-9]{1,32})\]/g, (_, token: string) => {
    if (!citations.some((each) => each.token === token)) return "";
    if (!tokens.includes(token)) tokens.push(token);
    return `${CHIP_OPEN}${tokens.indexOf(token) + 1}${CHIP_CLOSE}`;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the chips are drawn anew for each text.
  useLayoutEffect(() => {
    const root = drawn.current;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const holding: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node instanceof Text && node.data.includes(CHIP_OPEN)) holding.push(node);
    }
    for (const node of holding) {
      const parts = node.data.split(new RegExp(`${CHIP_OPEN}(\\d+)${CHIP_CLOSE}`));
      const pieces = parts.map((part, index) => {
        // A word joiner keeps each chip with the word before it, as a Note keeps its marks.
        if (index % 2 === 0)
          return document.createTextNode(index < parts.length - 1 ? `${part}\u2060` : part);
        const cited = citations.find((each) => each.token === tokens[Number(part) - 1]);
        const chip = document.createElement("span");
        chip.className = "citation-marker";
        chip.dataset.check = "found";
        chip.textContent = part;
        chip.title = cited
          ? `${cited.documentName}: “${cited.quote}”`
          : t("noteColumn.citation", { number: part });
        return chip;
      });
      node.replaceWith(...pieces);
    }
  }, [shown, t, citations]);
  return (
    <div key={shown} ref={drawn} data-testid="note-ask-reply" className="note-ask-reply-text">
      <MarkdownBlocks blocks={parseMarkdown(shown)} source={shown} highlight={[]} />
    </div>
  );
}
