import { useEffect, useRef } from "react";

/** What Esc closes, oldest first: the notices on screen. */
const showing: { dismiss(): void }[] = [];

/** Puts a notice among those Esc closes; returns what takes it out again. */
export function registerDismissable(dismiss: () => void): () => void {
  const entry = { dismiss };
  showing.push(entry);
  return () => {
    const at = showing.indexOf(entry);
    if (at !== -1) showing.splice(at, 1);
  };
}

/** Closes the newest notice on screen, which is the one nearest the corner; false if none shows. */
export function dismissNewest(): boolean {
  const newest = showing.at(-1);
  if (!newest) return false;
  newest.dismiss();
  return true;
}

/**
 * Whether a dialog, menu or picker is open, which closes by its own Esc before anything behind
 * it uses the key: not the copy of a closed menu still fading out, which is inert.
 */
export const dialogOrMenuOpen = (): boolean =>
  document.querySelector("dialog[open], :popover-open:not([inert])") !== null;

/** Lets Esc close this notice while it `active`ly shows: an error, a confirmation, a line about what was done. */
export function useDismissOnEscape(active: boolean, dismiss: () => void): void {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useEffect(() => (active ? registerDismissable(() => latest.current()) : undefined), [active]);
}

/**
 * Esc closes the newest notice (docs/agents/interaction.md, rule 7: the innermost thing that is
 * open): after everything else has had the key, so a text field, picker or editor that used it
 * (and marked it handled) keeps it, and not while a dialog or menu is open, which closes by
 * its own Esc. Whether one was open is seen before anything handles the key, as a native
 * one closes itself on Esc without marking the key handled. Once, for the window.
 */
export function useEscapeToDismiss(): void {
  useEffect(() => {
    let covered = false;
    const before = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      covered = dialogOrMenuOpen();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      const wasCovered = covered;
      setTimeout(() => {
        if (!wasCovered && !event.defaultPrevented) dismissNewest();
      }, 0);
    };
    window.addEventListener("keydown", before, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", before, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
