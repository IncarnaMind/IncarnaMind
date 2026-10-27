import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { displayName } from "../../../shared/documentNames";
import { menuKeysLabel } from "../commands/keymap";
import { commands } from "../commands/registry";
import { useDocumentFolder, useUnitCount } from "../documentFacts";
import { documentStatusText } from "../documentStatus";
import { addedDate, documentSummary, userFile } from "../fileInfo";
import { moveIntoFolder } from "../folderDrag";
import { useLanguage, useT } from "../i18n";
import { type Box, enterFrom } from "../motion";
import {
  focusPeekedRow,
  openPeeked,
  type PeekTarget,
  ROW_BUTTON,
  scopeOf,
  stepPeek,
  usePeek,
} from "../peek";
import { PEEK_WIDTH, placePeek } from "../peekPlace";
import { scanningStatus } from "../scanStatus";
import { refOfKey } from "../selectionModel";
import { useAppStore } from "../store";
import { ChevronDownLineIcon, DocumentLineIcon } from "./lineIcons";
import { MoveToPicker } from "./MoveToPicker";
import { PathText } from "./PathText";
import { PeekPage } from "./PeekPage";
import { DocumentTagChips } from "./TagChips";
import { buttonStyle } from "./ui";

/** How long the peek rests on a Document before its page is drawn: stepping with a held key skips the ones in between. */
const SETTLE_MS = 100;

/**
 * Peek: a quick look at a Document beside the list (Space on its row, in the
 * sidebar or the Library; see `usePeekKey`). Its name and facts show at once,
 * its first page follows; its Tags and Folder can be changed here. While it is
 * open the focus stays on the list: ↑ and ↓ move it to the next or previous
 * Document, Space or Esc puts it away, Enter opens the Document in the viewer.
 * It floats over the card and never replaces the Mind. Mounted once.
 */
export function Peek() {
  const target = usePeek((state) => state.target);
  return target ? <PeekCard target={target} /> : null;
}

/** Whether a Document has rested in the peek for `delay` ms: its page draws only then. */
function useSettled(key: string, delay: number): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key), delay);
    return () => clearTimeout(timer);
  }, [key, delay]);
  return settled === key;
}

/** Where the list and the row it opened beside were: it stays there while it steps through the rows. */
interface Beside {
  surface: PeekTarget["surface"];
  scope: DOMRect;
  row: DOMRect;
}

function besideOf(target: PeekTarget): Beside | null {
  const scope = scopeOf(target.row);
  return (
    scope && {
      surface: target.surface,
      scope: scope.getBoundingClientRect(),
      row: target.row.getBoundingClientRect(),
    }
  );
}

/** Puts the peek in its place, kept inside the window, and says where. */
function place(card: HTMLElement, beside: Beside): Box {
  const { width, height } = card.getBoundingClientRect();
  const spot = placePeek(
    beside.surface,
    beside.scope,
    beside.row,
    { width, height },
    {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  );
  card.style.left = `${spot.left}px`;
  card.style.top = `${spot.top}px`;
  return { ...spot, width, height };
}

/**
 * The keys and focus of an open peek, for the whole window: it is put away by
 * Esc, a press elsewhere, or the focus leaving its list; and the focus on a
 * Document's row in its list is what it shows.
 */
function useWhileOpen(card: RefObject<HTMLElement | null>) {
  // Before it is drawn, so no key reaches the list while the peek shows but doesn't answer.
  useLayoutEffect(() => {
    const inside = (node: EventTarget | null) =>
      node instanceof Element && (card.current?.contains(node) || node.closest("[popover]"));
    const onKey = (event: KeyboardEvent) => {
      const { target, close } = usePeek.getState();
      if (!target || event.isComposing) return;
      if (event.key === "Escape") {
        // What the peek opened (a picker, a dialog) closes first, by its own Esc.
        if (document.querySelector("dialog[open], :popover-open:not([inert], [data-peek])")) return;
        event.preventDefault();
        event.stopPropagation();
        if (card.current?.contains(document.activeElement)) focusPeekedRow();
        close();
        return;
      }
      const row = event.target;
      if (event.altKey || event.ctrlKey || event.metaKey || !(row instanceof HTMLElement)) return;
      if (!row.matches(ROW_BUTTON) || scopeOf(row)?.dataset.surface !== target.surface) return;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        stepPeek(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter" && !event.shiftKey) {
        close();
      } else if (event.key === "Tab" && !event.shiftKey) {
        const first = card.current?.querySelector<HTMLElement>("button");
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const { target, show, close } = usePeek.getState();
      const node = event.target;
      if (!target || !(node instanceof Element) || inside(node)) return;
      const row =
        scopeOf(node)?.dataset.surface === target.surface
          ? node.closest<HTMLElement>("[data-select-ref]")
          : null;
      const ref = refOfKey(row?.dataset.selectRef ?? "");
      if (!row || ref?.kind !== "document") close();
      else if (row !== target.row) show({ ...target, documentId: ref.id, row });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) usePeek.getState().close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [card]);
}

function PeekCard({ target }: { target: PeekTarget }) {
  const t = useT();
  const language = useLanguage();
  const card = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState<HTMLElement | null>(null);
  const document = useAppStore((state) =>
    state.documents.find((each) => each.id === target.documentId),
  );
  const settled = useSettled(`${target.documentId}:${document?.contentHash}`, SETTLE_MS);
  const units = useUnitCount(settled ? (document ?? null) : null);
  const folder = useDocumentFolder(target.documentId);
  useWhileOpen(card);

  // Opened before it is measured: a closed popover has no size.
  const beside = useRef<Beside | null>(null);
  const entered = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed where it opened, and not as it steps to other rows.
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    if (!element.matches(":popover-open")) element.showPopover();
    beside.current = besideOf(target);
    const box = beside.current && place(element, beside.current);
    if (box && !entered.current) enterFrom(element, target.row, box);
    entered.current = true;
  }, [target.surface]);

  useEffect(() => {
    const element = card.current;
    if (!element) return;
    const keepInside = () => beside.current && place(element, beside.current);
    const onResize = () => {
      const open = usePeek.getState().target;
      beside.current = (open && besideOf(open)) ?? beside.current;
      keepInside();
    };
    const observer = new ResizeObserver(keepInside);
    observer.observe(element);
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    if (!document) usePeek.getState().close();
  }, [document]);

  if (!document) return null;
  const name = displayName(document);
  const scanning =
    document.status === "extracting" && document.scan
      ? scanningStatus(document.scan, t).full
      : null;
  const progress =
    document.status === "ready" ? null : documentStatusText(document, t, language, scanning);
  const peekCommand = commands.get("document.peek");
  const key = peekCommand ? menuKeysLabel(peekCommand) : null;

  const ask = () => {
    usePeek.getState().close();
    commands
      .run("document.ask", {
        focus: { kind: "document", id: document.id },
        surface: target.surface,
      })
      .catch(useAppStore.getState().reportError);
  };

  return (
    <div
      ref={card}
      popover="manual"
      role="dialog"
      aria-label={t("peek.label", { name })}
      data-peek=""
      data-testid="peek"
      data-document-id={document.id}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
        const stops = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"),
        );
        const edge = event.shiftKey ? stops[0] : stops.at(-1);
        // Past its ends the focus goes back to the list, not on to the rest of the window.
        if (event.target === edge) {
          event.preventDefault();
          focusPeekedRow();
        }
      }}
      style={{ width: PEEK_WIDTH }}
      className="inset-auto m-0 flex max-h-[calc(100vh-16px)] flex-col overflow-y-auto rounded-[10px] border-0 bg-sheet p-0 text-ui text-ink shadow-popover"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <DocumentLineIcon kind={document.kind} className="size-4 shrink-0 text-ink-meta" />
        <p
          data-testid="peek-name"
          title={name}
          className="min-w-0 flex-1 truncate text-ui font-semibold text-ink"
        >
          {name}
        </p>
        {key && (
          <kbd className="inline-flex h-[18px] shrink-0 items-center rounded-sm bg-chip px-[5px] font-sans text-[11px] leading-[18px] font-semibold text-ink-secondary">
            {key}
          </kbd>
        )}
      </div>
      <div className="px-3.5 pt-2.5">
        <PeekPage document={document} settled={settled} />
      </div>
      <dl
        data-testid="peek-facts"
        className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1 px-3.5 pt-2.5 text-[12px] leading-[18px]"
      >
        <Fact label={t("peek.kind")} testId="peek-kind">
          <span className="block truncate">{documentSummary(document, units, t, language)}</span>
        </Fact>
        <Fact label={t("info.folder")} testId="peek-folder">
          <button
            type="button"
            title={t("mind.moveTo")}
            aria-haspopup="dialog"
            onClick={(event) => setMoving(event.currentTarget)}
            className="-ml-1 inline-flex max-w-full items-center gap-1 rounded-sm px-1 hover:bg-hover"
          >
            <span className="truncate">{folder?.name ?? t("library.unsorted")}</span>
            <ChevronDownLineIcon className="size-3 shrink-0 text-ink-meta" />
          </button>
        </Fact>
        <Fact label={t("info.tags")} testId="peek-tags">
          <DocumentTagChips document={document} variant="peek" />
        </Fact>
        <Fact label={t("info.added")} testId="peek-added">
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">{addedDate(document.createdAt, language)}</span>
            {(document.web || userFile(document)) && (
              <>
                <span aria-hidden="true" className="shrink-0 text-ink-meta">
                  ·
                </span>
                <PathText path={document.web?.address ?? document.path} className="flex-1" />
              </>
            )}
          </span>
        </Fact>
        {progress && (
          <Fact label={t("info.status")} testId="peek-status">
            {progress}
          </Fact>
        )}
      </dl>
      <div className="flex items-center gap-2 px-3.5 py-3">
        <button
          type="button"
          data-testid="peek-open"
          onClick={openPeeked}
          className={buttonStyle("primary", "sm")}
        >
          {t("mind.open")}
          <span aria-hidden="true" className="font-normal opacity-80">
            ↵
          </span>
        </button>
        <button
          type="button"
          data-testid="peek-ask"
          onClick={ask}
          className={buttonStyle("secondary", "sm")}
        >
          {t("peek.ask")}
        </button>
      </div>
      <MoveToPicker
        anchor={moving}
        name={name}
        current={folder?.id ?? null}
        onChoose={(folderId) => {
          if (folderId !== (folder?.id ?? null)) {
            void moveIntoFolder({ documentIds: [document.id] }, folderId);
          }
        }}
        onCreate={(folderName) =>
          void useAppStore.getState().createFolder({ documentIds: [document.id] }, folderName)
        }
        onClose={() => setMoving(null)}
      />
    </div>
  );
}

function Fact({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-meta">{label}</dt>
      <dd data-testid={testId} className="m-0 min-w-0 text-ink">
        {children}
      </dd>
    </>
  );
}
