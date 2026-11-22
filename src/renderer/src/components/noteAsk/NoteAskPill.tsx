import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { useEffect, useState } from "react";
import type { AgentToolName } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";

type Translate = ReturnType<typeof useT>;

import { RemoveIcon } from "../../editor/icons";
import { pendingIn } from "../../editor/proposalReview";
import { resolveProposalsIn } from "../../editWithAi";
import { useT } from "../../i18n";
import { allowAndAskAgain, type NoteAsk } from "../../ownAiInNote";
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

/**
 * A reply's Citation tokens, which the AI writes as it does in a Note; a Note shows them as chips,
 * and a reply leaves them out until it shows them as chips too.
 */
const withoutCitations = (reply: string) => reply.replace(/\s?\[cite:[a-z0-9]{1,32}\]/g, "");

/** The first words of a reply, as one line: its Markdown marks gone. */
export const firstWordsOf = (reply: string): string =>
  (
    withoutCitations(reply)
      .split(/\n/)
      .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "").trim())
      .find((line) => line !== "") ?? ""
  )
    .replace(/\*\*|__|`/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");

/** What the AI did, in IncarnaMind's words, for a reply that says nothing of it. */
function factsOf(ask: NoteAsk, t: Translate): string {
  const did = [
    ...(ask.changed > 0
      ? [
          t(ask.changed === 1 ? "noteAsk.done.changed.one" : "noteAsk.done.changed.other", {
            count: ask.changed,
          }),
        ]
      : []),
    ...ask.waiting.map((each) =>
      t(each.count === 1 ? "noteAsk.done.waiting.one" : "noteAsk.done.waiting.other", {
        count: each.count,
        title: each.title,
      }),
    ),
    ...ask.made.map((each) => t("noteAsk.done.wrote", { title: each.title })),
  ];
  return did.length > 0 ? did.join(" ") : t("noteAsk.done.nothing", { agent: ask.agent });
}

/** What a running request is doing, in the AI's own words where it wrote some. */
function doingOf(ask: NoteAsk, t: Translate): string {
  const { doing } = ask;
  if (doing === null) return t("noteAsk.pill.working");
  if (doing.kind === "thinking") return t("noteAsk.pill.thinking");
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
    return doing.tool === "read_passages"
      ? t("noteAsk.doing.read_passages.any")
      : t("noteAsk.pill.working");
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
 * The one line above a Note's input (#3677), as the User's AI app shows it: while a request runs,
 * what the AI is doing, in its own words where it wrote some, and the seconds since the request;
 * when it ends, the first words of its reply, with Accept all while its changes wait. Pressed, it
 * opens into the whole reply.
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
  const waiting = useWaitingInNote(editor);
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
      <div data-testid="note-ask-pill" data-state="failed" className="note-ask-pill">
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
            : t(`noteAsk.problem.${ask.problem ?? "failed"}` as MessageKey, {
                agent: ask.agent,
                found: ask.versions?.found ?? "",
                lowest: ask.versions?.lowest ?? "",
              })}
        </ProblemLine>
      </div>
    );
  }
  const words = firstWordsOf(ask.reply) || factsOf(ask, t);
  return (
    <div data-testid="note-ask-pill" data-state="landed" className="note-ask-pill">
      <button
        type="button"
        data-testid="note-ask-pill-open"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="note-ask-pill-text note-ask-pill-reply"
      >
        {words}
      </button>
      {waiting > 0 && <AcceptAll editor={editor} mindId={mindId} testId="note-ask-accept-all" />}
    </div>
  );
}

function AcceptAll({ editor, mindId, testId }: { editor: Editor; mindId: string; testId: string }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => resolveProposalsIn(editor, mindId, "all", "accept")}
      className="note-ask-pill-action"
    >
      {t("proposal.acceptAll")}
    </button>
  );
}

/** The whole reply, opened from the pill in its place: Accept all while changes wait, and the conversation. */
export function NoteAskCard({
  ask,
  mindId,
  editor,
  onClose,
  onOpenChat,
}: {
  ask: NoteAsk;
  mindId: string;
  editor: Editor;
  onClose(): void;
  onOpenChat(): void;
}) {
  const t = useT();
  const waiting = useWaitingInNote(editor);
  return (
    <section
      data-testid="note-ask-card"
      aria-label={t("noteAsk.reply")}
      className="note-ask-card"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <button
        type="button"
        data-testid="note-ask-card-close"
        aria-label={t("checks.close")}
        title={t("checks.close")}
        onClick={onClose}
        className="note-ask-card-close"
      >
        <RemoveIcon className="size-3" />
      </button>
      {ask.reply === "" ? (
        <p className="note-ask-reply-text">{factsOf(ask, t)}</p>
      ) : (
        <Reply text={ask.reply} />
      )}
      <div className="note-ask-card-actions">
        {waiting > 0 && (
          <AcceptAll editor={editor} mindId={mindId} testId="note-ask-card-accept-all" />
        )}
        <button
          type="button"
          data-testid="note-ask-open-chat"
          onClick={onOpenChat}
          className="note-ask-pill-action"
        >
          {t("noteAsk.openInChat")}
        </button>
      </div>
    </section>
  );
}

/** A reply as the AI wrote it: its paragraphs, lists and bold, as the app's other reading surfaces show Markdown. */
export function Reply({ text }: { text: string }) {
  const shown = withoutCitations(text);
  return (
    <div data-testid="note-ask-reply" className="note-ask-reply-text">
      <MarkdownBlocks blocks={parseMarkdown(shown)} source={shown} highlight={[]} />
    </div>
  );
}
