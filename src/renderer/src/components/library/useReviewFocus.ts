import { type RefObject, useEffect, useRef } from "react";

interface Held {
  id: string | null;
  next: string | null;
  prev: string | null;
}

const rowSelector = (id: string) => `[data-document-id="${CSS.escape(id)}"] [data-row-main]`;

/**
 * A row leaves To review from under the focus when it is accepted, turned down or moved, and the
 * focus falls to the page: this puts it on the row after, else before, else the page's first.
 */
export function useReviewFocus(page: RefObject<HTMLElement | null>, key: string): void {
  const held = useRef<Held | null>(null);

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const panel = target?.closest("[data-review]");
      if (!target || !panel) {
        held.current = null;
        return;
      }
      const rows = [...panel.querySelectorAll<HTMLElement>("[data-document-id]")].map(
        (row) => row.dataset.documentId ?? "",
      );
      const id = target.closest<HTMLElement>("[data-document-id]")?.dataset.documentId ?? null;
      const at = id === null ? -1 : rows.indexOf(id);
      held.current = {
        id,
        next: rows[at + 1] ?? null,
        prev: at > 0 ? (rows[at - 1] ?? null) : null,
      };
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: it looks again whenever the rows change.
  useEffect(() => {
    const was = held.current;
    if (!was) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const root = page.current;
        if (!root || (document.activeElement && document.activeElement !== document.body)) return;
        const panel = root.querySelector("[data-review]");
        const stays = (id: string | null) =>
          id !== null && panel?.querySelector(`[data-document-id="${CSS.escape(id)}"]`) != null;
        if (was.id !== null && stays(was.id)) return;
        const wanted = [was.next, was.prev].find(stays);
        const target =
          (wanted ? panel?.querySelector<HTMLElement>(rowSelector(wanted)) : null) ??
          root.querySelector<HTMLElement>("[data-tree-row]");
        held.current = null;
        target?.focus();
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [page, key]);
}
