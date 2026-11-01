import { autoUpdate } from "@floating-ui/dom";
import { type Editor, isMacOS } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { actOnAppliedEdit, restoreChange } from "../appliedEdits";
import { PencilLineIcon, SparkLineIcon } from "../components/lineIcons";
import { regenerateChange, resolveProposalsIn, speak, useEdits } from "../editWithAi";
import { useLanguage, useT } from "../i18n";
import { useReviewPanes } from "../reviewPane";
import { useAppStore } from "../store";
import {
  appliedLineIn,
  isAppliedAction,
  redrawAppliedLine,
  toggleAppliedOriginal,
} from "./appliedEditLine";
import { type ChangeBarBox, changeBarPlace, GAP_PX } from "./changeBarPlace";
import {
  changeReason,
  clearHovered,
  editorDoc,
  keepShownChange,
  outsideAgentOf,
  type PendingProposal,
  pendingAtSelection,
  pendingIn,
  shownProposal,
  sourcesRemoved,
  theirChange,
} from "./proposalReview";
import { redrawProposalRewrites, toggleProposalOriginal } from "./proposalRewrites";
import { madeByLine, namesList } from "./theirChanges";

/** How long the bar stays once the pointer leaves its change, so it can reach the bar. */
const LEAVE_MS = 300;

/** At most this much of a change's words is read out. */
const SPOKEN_CHARACTERS = 120;

const spokenText = (text: string) => {
  const flat = text.replace(/￼/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > SPOKEN_CHARACTERS ? `${flat.slice(0, SPOKEN_CHARACTERS - 1)}…` : flat;
};

/**
 * Proposals waiting in the Mind (#93), reviewed in place:
 *
 * - at the top of the Mind, while any wait: "3 changes waiting ·
 *   Accept all · Reject all", which stays in view as the Mind scrolls, and,
 *   for other people's changes from a Word file (#108), "4 changes from Dana
 *   Kim and Luis Ortega · Review", which opens the reviewing pane (#697) and
 *   goes while it is open;
 * - beside the change the pointer or the cursor is on, in the page's right
 *   margin, or, when there is no room, docked at the page's foot, its own bar:
 *   "Change 1 of 3 · Accept · Reject" (⌘↵, ⌘⌫), with who made someone's change and
 *   when, or "Proposed by {agent}" for an outside agent's (#352), and when it
 *   would remove a Citation, that it does, or when a
 *   Document it cites has been deleted, "Source removed" (#94); why the
 *   assistant made it, as a tooltip, and as a line under the bar when the
 *   cursor is in it (#202);
 * - under a change out of date, instead of its bar, "Out of date ·
 *   Regenerate · Reject" (drawn by `ProposalReview`; its buttons are handled
 *   here), without Regenerate for someone's: it can't be accepted;
 * - for screen readers, the change the cursor moves into, what it does and
 *   the keys that accept and reject it.
 *
 * The words themselves show what each change does: removed words struck,
 * new words underlined (styles.css), never colour alone. The second click
 * of a double click does nothing, so a change is never applied twice, nor
 * the next one that slid under the pointer.
 */
export function ProposalBars({ editor, mindId }: { editor: Editor; mindId: string }) {
  // "Regenerate" and "Reject" under a change out of date, in the note's text.
  useEffect(() => {
    const dom = editor.view.dom;
    const buttonOf = (event: Event) =>
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(
            "[data-proposal-regenerate], [data-proposal-reject], [data-applied-action], [data-applied-restore], [data-change-original]",
          )
        : null;
    // The text keeps the focus and its selection.
    const press = (event: MouseEvent) => {
      if (buttonOf(event)) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      const button = buttonOf(event);
      if (!button || repeated(event)) return;
      event.preventDefault();
      const original = button.dataset.changeOriginal;
      if (original) {
        if (original.startsWith("applied:")) toggleAppliedOriginal(editor, original);
        else toggleProposalOriginal(editor, original);
        return;
      }
      const applied = button.dataset.appliedAction;
      if (applied && isAppliedAction(applied)) {
        actOnAppliedEdit(editor, applied);
        if (!editor.isDestroyed) editor.commands.focus();
        return;
      }
      const restored = button.dataset.appliedRestore;
      if (restored !== undefined) {
        restoreChange(editor, Number(restored));
        if (!editor.isDestroyed) editor.commands.focus();
        return;
      }
      const rejected = button.dataset.proposalReject;
      if (rejected) {
        resolveProposalsIn(editor, mindId, [rejected], "reject");
        if (!editor.isDestroyed) editor.commands.focus();
        return;
      }
      const proposal = pendingIn(editor.state).find(
        (each) => each.id === button.dataset.proposalRegenerate,
      );
      const doc = editorDoc(editor);
      if (proposal && doc) void regenerateChange(editor, mindId, doc, proposal);
    };
    dom.addEventListener("mousedown", press);
    dom.addEventListener("click", click);
    return () => {
      dom.removeEventListener("mousedown", press);
      dom.removeEventListener("click", click);
    };
  }, [editor, mindId]);
  // The applied edit's lines and the "Was: …" lines are drawn outside React: again once the language changes.
  const language = useLanguage();
  useEffect(() => {
    redrawAppliedLine(editor, language);
    redrawProposalRewrites(editor);
  }, [editor, language]);
  return (
    <>
      <ProposalsBar editor={editor} mindId={mindId} />
      <ChangeBar editor={editor} mindId={mindId} />
      <Spoken editor={editor} mindId={mindId} />
    </>
  );
}

/** The second click of a double click: it does nothing more. */
const repeated = (event: MouseEvent) => event.detail > 1;

interface Group {
  ids: string[];
  stale: boolean;
}

interface Theirs {
  count: number;
  authors: (string | null)[];
}

/** The outside agents whose changes wait (#352), named when they made all the AI's there. */
interface Agents {
  names: string[];
  only: boolean;
}

function ProposalsBar({ editor, mindId }: { editor: Editor; mindId: string }) {
  const t = useT();
  const reviewing = useReviewPanes((state) => state.panes[mindId] !== undefined);
  const { theirs, assistant, agents } = useEditorState({
    editor,
    selector: ({ editor: current }): { theirs: Theirs; assistant: Group; agents: Agents } => {
      const theirs: Theirs = { count: 0, authors: [] };
      const assistant: Group = { ids: [], stale: false };
      const agents: Agents = { names: [], only: true };
      const line = appliedLineIn(current.state);
      // An edit held back has its own line.
      const ownLine = line?.kind === "held" ? line.request : null;
      for (const each of pendingIn(current.state)) {
        if (each.request === ownLine) continue;
        if (each.theirs) {
          const author = theirChange(current, each)?.author ?? null;
          theirs.count++;
          if (!theirs.authors.includes(author)) theirs.authors.push(author);
          continue;
        }
        assistant.ids.push(each.id);
        assistant.stale ||= each.outOfDate;
        const agent = outsideAgentOf(current, each);
        if (agent === null) agents.only = false;
        else if (!agents.names.includes(agent)) agents.names.push(agent);
      }
      return { theirs, assistant, agents };
    },
  });
  const theirLine = theirs.count > 0 && !reviewing;
  if (!theirLine && assistant.ids.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a region of the Mind, not a page landmark.
    <div
      role="region"
      aria-label={t(theirs.count > 0 ? "proposal.region.review" : "proposal.region")}
      data-testid="proposals-bar"
      className="proposals-bar"
    >
      {theirLine && <TheirChangesLine theirs={theirs} mindId={mindId} />}
      {assistant.ids.length > 0 && (
        <GroupLine
          group={assistant}
          agents={agents.only ? agents.names : []}
          every={theirs.count === 0}
          editor={editor}
          mindId={mindId}
        />
      )}
    </div>
  );
}

function TheirChangesLine({ theirs, mindId }: { theirs: Theirs; mindId: string }) {
  const t = useT();
  const language = useLanguage();
  const names = namesList(
    theirs.authors.map((author) => author ?? t("proposal.unknownAuthor")),
    language,
  );
  const said =
    theirs.count === 1
      ? t("review.line.one", { names })
      : t("review.line", { count: theirs.count, names });
  return (
    <div className="proposals-bar-line" data-testid="their-changes-line">
      <PencilLineIcon className="proposals-bar-icon" />
      <span data-testid="their-changes-count" title={said} className="min-w-0 truncate">
        {said}
      </span>
      <span aria-hidden="true" className="proposal-dot">
        ·
      </span>
      <button
        type="button"
        data-testid="their-changes-review"
        aria-label={t("review.title")}
        onClick={(event) => {
          if (!repeated(event.nativeEvent)) useReviewPanes.getState().open(mindId);
        }}
        className="proposal-action"
      >
        {t("review.open")}
      </button>
    </div>
  );
}

/**
 * The assistant's line: how many changes, and Accept all · Reject all for
 * them; for every change the Mind holds as it acts, when no one else's wait
 * (`every`), those an Undo has just brought back too.
 */
function GroupLine({
  group,
  agents,
  every,
  editor,
  mindId,
}: {
  group: Group;
  /** The outside agents that proposed them all; none when the assistant made any. */
  agents: string[];
  every: boolean;
  editor: Editor;
  mindId: string;
}) {
  const t = useT();
  const language = useLanguage();
  const count = group.ids.length;
  const resolveAll = (outcome: "accept" | "reject") => {
    resolveProposalsIn(editor, mindId, every ? "all" : group.ids, outcome);
  };
  return (
    <div className="proposals-bar-line" data-testid="proposals-line">
      <SparkLineIcon className="proposals-bar-icon" />
      <span data-testid="proposals-count" className="min-w-0 truncate">
        {count === 1 ? t("proposal.count.one") : t("proposal.count", { count })}
      </span>
      {agents.length > 0 && (
        <>
          <span aria-hidden="true" className="proposal-dot">
            ·
          </span>
          <span data-testid="proposals-agents" className="min-w-0 truncate">
            {t("proposal.proposedBy", { agent: namesList(agents, language) })}
          </span>
        </>
      )}
      <span aria-hidden="true" className="proposal-dot">
        ·
      </span>
      <button
        type="button"
        data-testid="proposals-accept-all"
        title={group.stale ? t("proposal.acceptAll.outOfDate") : undefined}
        onClick={(event) => {
          if (!repeated(event.nativeEvent)) resolveAll("accept");
        }}
        className="proposal-action"
      >
        {t("proposal.acceptAll")}
      </button>
      <span aria-hidden="true" className="proposal-dot">
        ·
      </span>
      <button
        type="button"
        data-testid="proposals-reject-all"
        onClick={(event) => {
          if (!repeated(event.nativeEvent)) resolveAll("reject");
        }}
        className="proposal-action"
      >
        {t("proposal.rejectAll")}
      </button>
    </div>
  );
}

/** Who made someone's change and when, as the file says: "Dana Kim, 2 Oct 2026". */
function useMadeBy(made: { author: string | null; date: string | null } | null): string | null {
  const t = useT();
  const language = useLanguage();
  return made ? madeByLine(made, t, language) : null;
}

interface Shown {
  id: string;
  index: number;
  count: number;
  from: number;
  to: number;
  end: number;
  dropped: number;
  citations: PendingProposal["citations"];
  /** Who made someone's change, and when; null for the assistant's. */
  made: { author: string | null; date: string | null } | null;
  /** The outside agent that proposed it (#352); null for anyone else's. */
  agent: string | null;
  /** Why the assistant made it; null when it didn't say. */
  reason: string | null;
  /** The cursor is in it, not only the pointer on it. */
  focused: boolean;
}

/** Every line the words of a change show, as one box; null when none of it shows. */
function changeBox(editor: Editor, from: number, to: number): ChangeBarBox | null {
  const start = editor.view.domAtPos(from);
  const end = editor.view.domAtPos(to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  let box: ChangeBarBox | null = null;
  for (const rect of range.getClientRects()) {
    if (rect.width < 1 || rect.height < 1) continue;
    box = box
      ? {
          left: Math.min(box.left, rect.left),
          top: Math.min(box.top, rect.top),
          right: Math.max(box.right, rect.right),
          bottom: Math.max(box.bottom, rect.bottom),
        }
      : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  return box;
}

const TEXT_BLOCK = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, td, th";

/** The text Block at a position, from either side of a Block boundary. */
function blockAt(editor: Editor, pos: number): Element | null {
  for (const at of [pos, pos + 1, pos - 1]) {
    if (at < 0 || at > editor.state.doc.content.size) continue;
    const found = editor.view.domAtPos(at);
    const node = found.node instanceof Element ? found.node : found.node.parentElement;
    const block = node?.closest(TEXT_BLOCK);
    if (block) return block;
  }
  return null;
}

/** The line box of the text at `pos`: how far down a card placed beside it may reach. */
function lineHeightAt(editor: Editor, pos: number): number {
  const block = blockAt(editor, pos) ?? editor.view.dom;
  const line = Number.parseFloat(getComputedStyle(block).lineHeight);
  return Number.isFinite(line) && line > 0 ? line : 26;
}

/**
 * Where the text on a change's lines ends, across the Blocks it spans: the
 * card goes past it, so it never covers words the change doesn't.
 */
function textRightOn(editor: Editor, from: number, to: number, band: ChangeBarBox): number {
  const first = blockAt(editor, from);
  if (!first) return band.right;
  const all = [...editor.view.dom.querySelectorAll(TEXT_BLOCK)];
  const start = all.indexOf(first);
  const found = blockAt(editor, to);
  const end = found ? all.indexOf(found) : start;
  let right = band.right;
  for (const block of all.slice(start, Math.max(start, end) + 1)) {
    const range = document.createRange();
    range.selectNodeContents(block);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.top >= band.bottom || rect.bottom <= band.top) continue;
      right = Math.max(right, rect.right);
    }
  }
  return right;
}

/**
 * Scrolls the Mind so a docked card's change, and the line after it, stay
 * above the card, and the change's first line stays in view.
 */
function scrollAboveCard(
  editor: Editor,
  change: ChangeBarBox,
  lineHeight: number,
  cardTop: number,
): void {
  const scroller = editor.view.dom.closest<HTMLElement>(".mind-scroller");
  if (!scroller) return;
  const view = scroller.getBoundingClientRect();
  let down = change.bottom + lineHeight + GAP_PX - cardTop;
  if (down <= 0) return;
  down = Math.min(down, Math.max(0, change.top - view.top - GAP_PX));
  const most = scroller.scrollHeight - scroller.clientHeight;
  const next = Math.min(most, scroller.scrollTop + down);
  if (next > scroller.scrollTop) scroller.scrollTop = next;
}

/**
 * A change's bar goes beside the change in the page view's right margin when
 * about 300px are free there, and at the page view's foot otherwise, never at
 * the window's corner (#1358, #1826); it follows the change as the Mind scrolls.
 * Docked, it scrolls the change above it only while the cursor is in the
 * change: scrolling under a still pointer would move the text out from under it.
 */
function useBarPlace(
  editor: Editor,
  bar: RefObject<HTMLDivElement | null>,
  change: { from: number; to: number; end: number; focused: boolean } | null,
): void {
  useLayoutEffect(() => {
    const element = bar.current;
    if (!change || !element || editor.isDestroyed) return;
    const place = () => {
      if (editor.isDestroyed) return;
      const box = changeBox(editor, change.from, change.end);
      const pageOf = editor.view.dom.closest(".mind-tab-page");
      const page = pageOf?.getBoundingClientRect();
      if (!box || !page) return;
      const barOfChanges = editor.view.dom
        .closest(".mind-editor-frame")
        ?.querySelector(".proposals-bar")
        ?.getBoundingClientRect();
      const pill = editor.view.dom
        .closest(".workbench")
        ?.querySelector('[data-testid="ask-pill"]')
        ?.getBoundingClientRect();
      const badge = pageOf?.querySelector(".mind-foot-badge .check-badge")?.getBoundingClientRect();
      // Its natural width, before this placement's cap.
      element.style.maxWidth = "";
      const size = { width: element.offsetWidth, height: element.offsetHeight };
      const line = lineHeightAt(editor, change.from);
      const at = changeBarPlace(
        box,
        textRightOn(editor, change.from, change.end, box),
        {
          left: page.left,
          top: Math.max(page.top, barOfChanges?.bottom ?? page.top),
          right: page.right,
          bottom: page.bottom,
        },
        size,
        line,
        {
          right: Math.min(page.right, badge ? badge.left - GAP_PX : page.right),
          bottom: Math.min(page.bottom, pill ? pill.top : page.bottom),
        },
      );
      element.style.maxWidth = `${at.maxWidth}px`;
      Object.assign(element.style, { left: `${at.x}px`, top: `${at.y}px`, visibility: "visible" });
      if (at.kind === "dock" && change.focused) scrollAboveCard(editor, box, line, at.y);
    };
    return autoUpdate(editor.view.dom, element, place);
  }, [editor, bar, change]);
}

function ChangeBar({ editor, mindId }: { editor: Editor; mindId: string }) {
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const over = useRef(false);
  const shown = useEditorState({
    editor,
    selector: ({ editor: current }): Shown | null => {
      const proposal = shownProposal(current.state);
      // One out of date has its line under it instead.
      if (!proposal || proposal.outOfDate) return null;
      const all = pendingIn(current.state);
      const first = proposal.ranges[0] ?? proposal;
      const last = proposal.ranges.at(-1) ?? proposal;
      return {
        id: proposal.id,
        index: all.findIndex((each) => each.id === proposal.id) + 1,
        count: all.length,
        from: first.from,
        to: first.to,
        end: last.to,
        dropped: proposal.droppedCitations,
        citations: proposal.citations,
        made: proposal.theirs ? theirChange(current, proposal) : null,
        agent: proposal.theirs ? null : outsideAgentOf(current, proposal),
        reason: proposal.theirs ? null : changeReason(current, proposal),
        focused: pendingAtSelection(current.state).some((each) => each.id === proposal.id),
      };
    },
  });
  const madeBy =
    useMadeBy(shown?.made ?? null) ??
    (shown?.agent ? t("proposal.proposedBy", { agent: shown.agent }) : null);
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const kept = useAppStore((state) => state.keptCitationTexts);

  // The pointer leaving a change takes its bar away, unless it went onto the bar.
  useEffect(() => {
    const dom = editor.view.dom;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const leave = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!over.current) clearHovered(editor);
      }, LEAVE_MS);
    };
    const move = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-proposal-id]")) clearTimeout(timer);
      else leave();
    };
    dom.addEventListener("mousemove", move);
    dom.addEventListener("mouseleave", leave);
    return () => {
      clearTimeout(timer);
      dom.removeEventListener("mousemove", move);
      dom.removeEventListener("mouseleave", leave);
    };
  }, [editor]);

  useBarPlace(editor, bar, shown);

  if (!shown) return null;
  const removedSources = sourcesRemoved(shown, documents, kept);
  const resolve = (event: ReactMouseEvent, outcome: "accept" | "reject") => {
    if (repeated(event.nativeEvent)) return;
    over.current = false;
    resolveProposalsIn(editor, mindId, [shown.id], outcome);
    if (!editor.isDestroyed) editor.commands.focus();
  };
  const keys = isMacOS()
    ? { accept: "⌘↩", reject: "⌘⌫" }
    : { accept: "Ctrl+Enter", reject: "Ctrl+Backspace" };
  const why = shown.reason ? t("proposal.why", { reason: shown.reason }) : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar of one change's actions, beside the text.
    <div
      ref={bar}
      role="group"
      aria-label={t("proposal.position", { index: shown.index, count: shown.count })}
      data-testid="change-bar"
      data-proposal-id={shown.id}
      onMouseEnter={() => {
        over.current = true;
        keepShownChange(editor.view);
      }}
      onMouseLeave={() => {
        over.current = false;
        clearHovered(editor);
      }}
      // The text keeps the focus and its selection.
      onMouseDown={(event) => event.preventDefault()}
      title={why ?? undefined}
      className="change-bar"
      style={{ visibility: "hidden" }}
    >
      <div className="change-bar-row">
        <span className="change-bar-position">
          {t("proposal.position", { index: shown.index, count: shown.count })}
        </span>
        {madeBy && (
          <span data-testid="change-bar-author" className="change-bar-author">
            {madeBy}
          </span>
        )}
        {shown.dropped > 0 && (
          <span data-testid="change-bar-drops" className="change-bar-drops">
            {shown.dropped === 1
              ? t("proposal.dropsCitations.one")
              : t("proposal.dropsCitations", { count: shown.dropped })}
          </span>
        )}
        {removedSources > 0 && (
          <span
            data-testid="change-bar-source-removed"
            title={t("proposal.sourceRemoved.why")}
            className="change-bar-drops"
          >
            {t("proposal.sourceRemoved")}
          </span>
        )}
        <button
          type="button"
          data-testid="change-accept"
          title={`${t("proposal.accept")} (${keys.accept})`}
          aria-keyshortcuts={isMacOS() ? "Meta+Enter" : "Control+Enter"}
          onClick={(event) => resolve(event, "accept")}
          className="proposal-action"
        >
          {t("proposal.accept")}
        </button>
        <span aria-hidden="true" className="proposal-dot">
          ·
        </span>
        <button
          type="button"
          data-testid="change-reject"
          title={`${t("proposal.reject")} (${keys.reject})`}
          aria-keyshortcuts={isMacOS() ? "Meta+Backspace" : "Control+Backspace"}
          onClick={(event) => resolve(event, "reject")}
          className="proposal-action"
        >
          {t("proposal.reject")}
        </button>
      </div>
      {why && shown.focused && (
        <div data-testid="change-bar-why" className="change-bar-why">
          {why}
        </div>
      )}
    </div>
  );
}

/** What a change does, in words, for a screen reader; whose, for someone's (`author`). */
function describe(
  proposal: PendingProposal,
  t: ReturnType<typeof useT>,
  author: string | null,
): string {
  const removed = spokenText(proposal.removed);
  const added = spokenText(proposal.added);
  const what =
    removed && added
      ? t("proposal.announce.replace", { removed, added })
      : added
        ? t("proposal.announce.add", { added })
        : t("proposal.announce.remove", { removed });
  const platform = isMacOS() ? "mac" : "other";
  const accept = t(`proposal.keys.accept.${platform}`);
  const reject = t(`proposal.keys.reject.${platform}`);
  if (author !== null) {
    return proposal.outOfDate
      ? t("proposal.announce.theirs.outOfDate", { author, what, reject })
      : t("proposal.announce.theirs", { author, what, accept, reject });
  }
  if (proposal.outOfDate) return t("proposal.announce.outOfDate", { what, reject });
  return t("proposal.announce", { what, accept, reject });
}

/** The Mind's polite live region: the change the cursor moves into, and what was accepted or rejected. */
function Spoken({ editor, mindId }: { editor: Editor; mindId: string }) {
  const t = useT();
  const spoken = useEdits((state) => state.spoken[mindId]);
  const focused = useEditorState({
    editor,
    selector: ({ editor: current }) => pendingAtSelection(current.state)[0]?.id ?? null,
  });
  useEffect(() => {
    if (!focused || editor.isDestroyed) return;
    const proposal = pendingIn(editor.state).find((each) => each.id === focused);
    if (!proposal) return;
    const made = proposal.theirs ? theirChange(editor, proposal) : null;
    const author = made
      ? (made.author ?? t("proposal.unknownAuthor"))
      : outsideAgentOf(editor, proposal);
    speak(mindId, describe(proposal, t, author), proposal.id);
  }, [focused, editor, mindId, t]);
  const current = spoken?.about === undefined || spoken.about === focused;
  return (
    <div role="status" aria-live="polite" data-testid="proposal-spoken" className="sr-only">
      {current && spoken?.text}
    </div>
  );
}
