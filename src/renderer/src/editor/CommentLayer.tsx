/**
 * Comments on the page (#328): each one's card beside the words it is on, in
 * the space to the right of the Citation checks, and a Comments list for the
 * Mind. Under a narrow Mind the cards fold into a count in the page's top
 * corner, which opens the list.
 */
import type { Editor } from "@tiptap/core";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as Y from "yjs";
import { type CommentMessage, MIND_COMMENTS_FIELD, type MindComment } from "../../../core/api";
import { formatDateTime } from "../../../shared/dates";
import {
  ASSISTANT_AUTHOR,
  authorName,
  type CommentPlace,
  cancelComment,
  commentsOf,
  deleteComment,
  editComment,
  myName,
  placeOf,
  quoteAt,
  replyToComment,
  resolveComment,
  saveComment,
  useCommentsUi,
} from "../comments";
import { TypingTextarea } from "../components/TypingTextarea";
import { requestEdit } from "../editWithAi";
import { useLanguage, useT } from "../i18n";
import { COMMENTS_REDRAWN, commentRuns } from "./commentSchema";
import { Popover } from "./Popover";

/**
 * The room a card beside the text takes, as `styles.css` › `.comment-card-place`
 * lays it out: 16px past the Citation checks' 48px gutter, its 264px, and 16px
 * inside the page's right edge. When the column leaves less, the text column
 * moves left, up to the card's width, so the card sits beside it; only when that
 * still isn't enough do the cards fold into the count (#328). The shift is set
 * before the first paint, so a Note opened with comments is laid out at once.
 */
const COMMENT_GAP = 64;
const COMMENT_WIDTH = 264;
const COMMENT_EDGE = 16;
const COMMENT_MOST_SHIFT = 264;

function useRoomBeside(editor: Editor, wanted: boolean): boolean {
  const [room, setRoom] = useState(true);
  useLayoutEffect(() => {
    const column = editor.view.dom.closest<HTMLElement>(".mind-column");
    const frame = editor.view.dom.closest<HTMLElement>(".mind-editor-frame");
    if (!column || !frame) return;
    const reset = () => column.style.setProperty("--comment-shift", "0px");
    if (!wanted) {
      reset();
      setRoom(false);
      return reset;
    }
    const needed = COMMENT_GAP + COMMENT_WIDTH + COMMENT_EDGE;
    // The page keeps its left edge: the text never moves past this gutter.
    const LEFT_EDGE = 40;
    const measure = () => {
      // The shift already applied is part of the room and the margin measured: take it out first.
      const applied =
        Number.parseFloat(column.style.getPropertyValue("--comment-shift") || "0") || 0;
      const columnRect = column.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const natural = columnRect.right - frameRect.right - applied;
      const room = Math.max(0, frameRect.left - columnRect.left + applied - LEFT_EDGE);
      const shift = Math.max(0, Math.min(COMMENT_MOST_SHIFT, room, needed - natural));
      const fits = natural + shift >= needed - 0.5;
      column.style.setProperty("--comment-shift", `${fits ? shift : 0}px`);
      setRoom(fits);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(frame);
    return () => {
      observer.disconnect();
      reset();
    };
  }, [editor, wanted]);
  return room;
}

/** The comments of the Mind, read again whenever the map or the text changes. */
export function useLiveComments(editor: Editor, doc: Y.Doc): MindComment[] {
  const [comments, setComments] = useState(() => commentsOf(doc));
  useEffect(() => {
    const map = doc.getMap(MIND_COMMENTS_FIELD);
    const read = () => setComments(commentsOf(doc));
    const changed = () => {
      read();
      if (!editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta(COMMENTS_REDRAWN, true));
      }
    };
    read();
    map.observe(changed);
    editor.on("update", read);
    return () => {
      map.unobserve(changed);
      if (!editor.isDestroyed) editor.off("update", read);
    };
  }, [editor, doc]);
  return comments;
}

/** The mark's ids on the text now, and where each starts and ends. */
function placesOf(editor: Editor): Map<string, CommentPlace> {
  const places = new Map<string, CommentPlace>();
  for (const run of commentRuns(editor.state.doc)) {
    const place = places.get(run.id);
    if (place) place.to = run.to;
    else places.set(run.id, { from: run.from, to: run.to });
  }
  return places;
}

/** The comment card beside each comment's words, in the page's order. */
export function CommentLayer({
  editor,
  mindId,
  doc,
  readOnly = false,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  /** A Mind a newer version wrote: its comments show, and nothing changes them. */
  readOnly?: boolean;
}) {
  const comments = useLiveComments(editor, doc);
  const draft = useCommentsUi((state) => (state.draft?.mindId === mindId ? state.draft : null));
  const layer = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ id: string; top: number }[]>([]);
  // Read each render: a text change moves a comment's words without changing the comment map.
  const places = placesOf(editor);

  // The comment being typed opens at its words, in `DraftComment`, at every width.
  const shown = comments.filter(
    (comment) => comment.id !== draft?.id && places.has(comment.id) && comment.resolvedAt === null,
  );
  const shownKey = shown.map((comment) => comment.id).join("|");
  const beside = useRoomBeside(editor, shown.length > 0);

  const measure = useCallback(() => {
    const element = layer.current;
    const frame = element?.parentElement;
    if (!element || !frame) return;
    const cards = [...element.querySelectorAll<HTMLElement>("[data-comment-card]")];
    const next: { id: string; top: number }[] = [];
    let bottom = -Infinity;
    for (const card of cards) {
      const id = card.dataset.commentCard;
      if (!id) continue;
      const anchor = Number(card.dataset.anchorTop ?? "0");
      const top = Math.max(anchor, bottom + 8);
      next.push({ id, top });
      bottom = top + card.getBoundingClientRect().height;
    }
    setPlaced((was) =>
      was.length === next.length &&
      was.every(
        (each, at) => each.id === next[at]?.id && Math.abs(each.top - (next[at]?.top ?? 0)) < 0.5,
      )
        ? was
        : next,
    );
  }, []);

  useEffect(() => {
    if (!beside || shownKey === "") {
      setPlaced([]);
      return;
    }
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    later();
    const observer = new ResizeObserver(later);
    for (const card of layer.current?.querySelectorAll("[data-comment-card]") ?? []) {
      observer.observe(card);
    }
    const changed = () => later();
    editor.on("update", changed);
    window.addEventListener("resize", changed);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (!editor.isDestroyed) editor.off("update", changed);
      window.removeEventListener("resize", changed);
    };
  }, [beside, editor, measure, shownKey]);

  if (!beside) return null;
  const frame = layer.current?.parentElement;

  return (
    <div className="comments-layer" ref={layer} data-testid="comment-layer">
      {shown.map((comment) => {
        const place = places.get(comment.id) ?? null;
        const coords = place && frame ? editor.view.coordsAtPos(place.from) : null;
        const anchorTop = coords && frame ? coords.top - frame.getBoundingClientRect().top : 0;
        const top = placed.find((each) => each.id === comment.id)?.top ?? anchorTop;
        return (
          <div
            key={comment.id}
            className="comment-card-place"
            data-comment-card={comment.id}
            data-anchor-top={anchorTop}
            style={{ top }}
          >
            <CommentCard
              editor={editor}
              mindId={mindId}
              doc={doc}
              comment={comment}
              place={place}
              draft={comment.id === draft?.id}
              readOnly={readOnly}
            />
          </div>
        );
      })}
    </div>
  );
}

/** The comment being typed, opened at its words wherever they are, as Word and Google Docs open one. */
export function DraftComment({
  editor,
  mindId,
  doc,
  readOnly = false,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  readOnly?: boolean;
}) {
  const draft = useCommentsUi((state) => (state.draft?.mindId === mindId ? state.draft : null));
  const comments = useLiveComments(editor, doc);
  const endDraft = useCommentsUi((state) => state.endDraft);
  const found = draft ? comments.find((each) => each.id === draft.id) : undefined;
  // The draft isn't in the Mind yet: it is saved only when it says something (#328).
  const comment: MindComment | undefined =
    found ??
    (draft
      ? {
          id: draft.id,
          author: null,
          createdAt: draft.createdAt,
          text: "",
          resolvedAt: null,
          replies: [],
        }
      : undefined);
  if (!draft || !comment || readOnly) return null;
  const place = placeOf(editor, comment.id) ?? draft.place;
  if (!place) return null;
  const anchor = {
    getBoundingClientRect: () => {
      const coords = editor.view.coordsAtPos(place.from);
      return {
        ...coords,
        x: coords.left,
        y: coords.top,
        width: 0,
        height: coords.bottom - coords.top,
      };
    },
  };
  return (
    <Popover
      anchor={anchor}
      placement="bottom-start"
      onDismiss={() => {
        cancelComment(editor, doc, comment.id, place);
        endDraft();
      }}
    >
      <div className="comment-card-place comment-card-place--asked" data-testid="comment-draft">
        <CommentCard
          editor={editor}
          mindId={mindId}
          doc={doc}
          comment={comment}
          place={place}
          draft
        />
      </div>
    </Popover>
  );
}

type Editing = { kind: "new" } | { kind: "root" } | { kind: "reply"; id: string } | null;

/** A comment's thread, beside its words or in the list's popover. */
export function CommentCard({
  editor,
  mindId,
  doc,
  comment,
  place,
  draft = false,
  readOnly = false,
  onSettled,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  comment: MindComment;
  place: CommentPlace | null;
  draft?: boolean;
  readOnly?: boolean;
  /** A card opened in a popover closes once it is resolved, reopened or deleted. */
  onSettled?(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const me = myName();
  const [editing, setEditing] = useState<Editing>(draft ? { kind: "new" } : null);
  const field = useRef<HTMLTextAreaElement>(null);
  // A native popover takes the focus for itself: the card being typed asks for it back, after
  // the menu that opened it has handed the focus to the text.
  useEffect(() => {
    if (!draft) return;
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [draft]);
  const [draftText, setDraftText] = useState(comment.text);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const endDraft = useCommentsUi((state) => state.endDraft);

  const saveEditing = () => {
    const words = draftText.trim();
    if (editing?.kind === "new") {
      if (words === "") return cancelComment(editor, doc, comment.id, place);
      saveComment(editor, doc, comment.id, draftText, comment.createdAt, place);
      endDraft();
    } else if (editing?.kind === "root") {
      if (words !== "") editComment(doc, comment.id, null, draftText);
    } else if (editing?.kind === "reply") {
      if (words !== "") editComment(doc, comment.id, editing.id, draftText);
    }
    setEditing(null);
  };

  const cancelEditing = () => {
    if (editing?.kind === "new") {
      cancelComment(editor, doc, comment.id, place);
      endDraft();
    }
    setEditing(null);
    setDraftText(comment.text);
  };

  const textKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      saveEditing();
    }
  };

  const address = async () => {
    if (!place || working) return;
    setMenuOpen(false);
    setWorking(true);
    try {
      const instruction = t("comments.assistant.instruction", {
        comment: comment.text,
        quote: quoteAt(editor, place),
      });
      // The reply says the text changed only once it has: a change still to accept has none yet.
      const applied = await requestEdit(editor, mindId, doc, "instruction", instruction, place);
      if (applied) {
        replyToComment(doc, comment.id, t("comments.assistant.replied"), ASSISTANT_AUTHOR);
      }
    } finally {
      setWorking(false);
    }
  };

  const messages: { id: string | null; message: CommentMessage }[] = [
    { id: null, message: comment },
    ...comment.replies.map((message) => ({ id: message.id, message })),
  ];

  return (
    <section
      className={`comment-card ${comment.resolvedAt ? "comment-card--resolved" : ""}`}
      data-testid={`comment-card-${comment.id}`}
      aria-label={t("comments.card")}
    >
      {messages.map(({ id, message }, at) => {
        const editingThis =
          id === null
            ? editing?.kind === "new" || editing?.kind === "root"
            : editing?.kind === "reply" && editing.id === id;
        return (
          <div
            key={id ?? "comment"}
            className={`comment-message ${at === 0 ? "comment-message--root" : ""}`}
          >
            <div className="comment-message-head">
              <span className="comment-author">
                {authorName(message.author, me, t("comments.someone"))}
              </span>
              <time dateTime={message.createdAt}>
                {formatDateTime(message.createdAt, language)}
              </time>
              {at === 0 && comment.resolvedAt && (
                <span className="comment-resolved">{t("comments.resolved")}</span>
              )}
            </div>
            {editingThis ? (
              <div className="comment-compose">
                <TypingTextarea
                  ref={draft && editing?.kind === "new" ? field : undefined}
                  className="comment-field"
                  value={draftText}
                  autoFocus
                  rows={3}
                  onChange={(event) => setDraftText(event.target.value)}
                  onKeyDown={textKeys}
                />
                <div className="comment-compose-row">
                  <button
                    type="button"
                    className="comment-send"
                    data-testid={draft ? "comment-save" : "comment-edit-save"}
                    onClick={saveEditing}
                  >
                    {draft ? t("comments.comment") : t("comments.save")}
                  </button>
                  <button type="button" className="comment-quiet" onClick={cancelEditing}>
                    {t("comments.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <p className="comment-text">{message.text}</p>
            )}
            {id !== null && message.author === null && !editingThis && !readOnly && (
              <div className="comment-message-actions">
                <button
                  type="button"
                  className="comment-quiet"
                  onClick={() => {
                    setDraftText(message.text);
                    setEditing({ kind: "reply", id });
                  }}
                >
                  {t("comments.edit")}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {!draft &&
        !readOnly &&
        (replying ? (
          <div className="comment-compose">
            <TypingTextarea
              className="comment-field"
              value={reply}
              autoFocus
              rows={2}
              placeholder={t("comments.replyPlaceholder")}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setReply("");
                  setReplying(false);
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (reply.trim() === "") return;
                  replyToComment(doc, comment.id, reply);
                  setReply("");
                  setReplying(false);
                }
              }}
            />
            <div className="comment-compose-row">
              <button
                type="button"
                className="comment-send"
                data-testid={`comment-reply-send-${comment.id}`}
                disabled={reply.trim() === ""}
                onClick={() => {
                  if (reply.trim() === "") return;
                  replyToComment(doc, comment.id, reply);
                  setReply("");
                  setReplying(false);
                }}
              >
                {t("comments.reply")}
              </button>
              <button
                type="button"
                className="comment-quiet"
                onClick={() => {
                  setReply("");
                  setReplying(false);
                }}
              >
                {t("comments.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="comment-actions">
            <button
              type="button"
              className="comment-quiet"
              data-testid={`comment-reply-${comment.id}`}
              onClick={() => setReplying(true)}
            >
              {t("comments.reply")}
            </button>
            <button
              type="button"
              className="comment-quiet"
              data-testid={`comment-resolve-${comment.id}`}
              onClick={() => {
                resolveComment(doc, comment.id, comment.resolvedAt === null);
                onSettled?.();
              }}
            >
              {comment.resolvedAt ? t("comments.reopen") : t("comments.resolve")}
            </button>
            <button
              ref={menuButton}
              type="button"
              className="comment-quiet"
              aria-label={t("comments.more")}
              aria-haspopup="menu"
              data-testid={`comment-menu-${comment.id}`}
              onClick={() => setMenuOpen(true)}
            >
              ⋯
            </button>
            {menuOpen && menuButton.current && (
              <Popover
                anchor={menuButton.current}
                placement="bottom-end"
                onDismiss={() => setMenuOpen(false)}
              >
                <div role="menu" className="comment-menu">
                  {comment.author === null && (
                    <button
                      type="button"
                      role="menuitem"
                      className="comment-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        setDraftText(comment.text);
                        setEditing({ kind: "root" });
                      }}
                    >
                      {t("comments.edit")}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className="comment-menu-item"
                    disabled={!place || working}
                    data-testid={`comment-address-${comment.id}`}
                    onClick={() => void address()}
                  >
                    {working ? t("comments.assistant.working") : t("comments.address")}
                  </button>
                  {comment.author === null && (
                    <button
                      type="button"
                      role="menuitem"
                      className="comment-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        deleteComment(doc, comment.id);
                        onSettled?.();
                      }}
                    >
                      {t("comments.delete")}
                    </button>
                  )}
                </div>
              </Popover>
            )}
          </div>
        ))}
    </section>
  );
}

/** The count in the page's top corner: opens the Comments list, where cards fold. */
export function CommentsButton({
  editor,
  mindId,
  doc,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
}) {
  const t = useT();
  const comments = useLiveComments(editor, doc);
  const open = useCommentsUi((state) => state.listOpen === mindId);
  const showList = useCommentsUi((state) => state.showList);
  const button = useRef<HTMLButtonElement>(null);
  const ask = useCommentsUi((state) => state.ask);
  // A click on a comment's words opens it: its card beside them, or the list's card when they fold.
  useEffect(() => {
    const dom = editor.view.dom;
    const click = (event: MouseEvent) => {
      const target =
        event.target instanceof Element ? event.target.closest("[data-comment-id]") : null;
      const id = target instanceof HTMLElement ? target.dataset.commentId : undefined;
      if (!id) return;
      // Beside the text its card is already there: mark it rather than open a second one over it.
      const beside = editor.view.dom
        .closest(".mind-tab-page")
        ?.querySelector<HTMLElement>(`[data-comment-card="${id}"]`);
      if (beside) {
        beside.dataset.highlight = "true";
        window.setTimeout(() => delete beside.dataset.highlight, 1_200);
        return;
      }
      ask(mindId, id);
    };
    dom.addEventListener("click", click);
    return () => dom.removeEventListener("click", click);
  }, [editor, mindId, ask]);
  if (comments.length === 0) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="comments-count"
        data-testid="comments-count"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => showList(open ? null : mindId)}
      >
        {t("comments.fold", { count: comments.length })}
      </button>
      {open && button.current && (
        <CommentsList
          editor={editor}
          mindId={mindId}
          comments={comments}
          anchor={button.current}
          onClose={() => showList(null)}
        />
      )}
    </>
  );
}

/** Open and resolved comments, in the page's order, each a click that goes to its words. */
export function CommentsList({
  editor,
  mindId,
  comments,
  anchor,
  onClose,
}: {
  editor: Editor;
  mindId: string;
  comments: readonly MindComment[];
  anchor: HTMLElement;
  onClose(): void;
}) {
  const t = useT();
  const me = myName();
  const ask = useCommentsUi((state) => state.ask);
  const inOrder = useMemo(() => {
    const placed = comments.map((comment) => ({ comment, place: placeOf(editor, comment.id) }));
    return placed.sort((a, b) => {
      if (a.place && b.place) return a.place.from - b.place.from;
      if (a.place) return -1;
      if (b.place) return 1;
      return a.comment.createdAt.localeCompare(b.comment.createdAt);
    });
  }, [comments, editor]);
  return (
    <Popover
      anchor={anchor}
      placement="bottom-end"
      onDismiss={onClose}
      className="comments-list-popover"
    >
      <div
        role="dialog"
        aria-label={t("comments.list")}
        className="comments-list"
        data-testid="comments-list"
      >
        <div className="comments-list-head">{t("comments.list")}</div>
        {inOrder.map(({ comment, place }) => (
          <button
            key={comment.id}
            type="button"
            className="comments-list-row"
            data-testid={`comments-row-${comment.id}`}
            onClick={() => {
              if (place) editor.chain().focus().setTextSelection(place).scrollIntoView().run();
              ask(mindId, comment.id);
              onClose();
            }}
          >
            <span className="comments-list-top">
              <span className="comment-author">
                {authorName(comment.author, me, t("comments.someone"))}
              </span>
              {comment.resolvedAt && (
                <span className="comment-resolved">{t("comments.resolved")}</span>
              )}
            </span>
            <span className="comments-list-text">
              {place ? comment.text : `${comment.text} · ${t("comments.textRemoved")}`}
            </span>
          </button>
        ))}
      </div>
    </Popover>
  );
}

/** A comment opened from the list: its card at its words, or at the count when they were deleted. */
export function AskedComment({
  editor,
  mindId,
  doc,
  fallback,
  readOnly = false,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  fallback: HTMLElement | null;
  readOnly?: boolean;
}) {
  const asked = useCommentsUi((state) => (state.asked?.mindId === mindId ? state.asked : null));
  const shown = useCommentsUi((state) => state.askedShown);
  const comments = useLiveComments(editor, doc);
  const comment = asked ? comments.find((each) => each.id === asked.id) : undefined;
  const place = comment ? placeOf(editor, comment.id) : null;
  if (!comment) return null;
  const anchor =
    place && !editor.isDestroyed
      ? {
          getBoundingClientRect: () => {
            const coords = editor.view.coordsAtPos(place.from);
            return {
              ...coords,
              x: coords.left,
              y: coords.top,
              width: 0,
              height: coords.bottom - coords.top,
            };
          },
        }
      : (fallback ?? editor.view.dom);
  return (
    <Popover anchor={anchor} placement="bottom-end" onDismiss={shown}>
      <div className="comment-card-place comment-card-place--asked">
        <CommentCard
          editor={editor}
          mindId={mindId}
          doc={doc}
          comment={comment}
          place={place}
          readOnly={readOnly}
          onSettled={shown}
        />
      </div>
    </Popover>
  );
}
