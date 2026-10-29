/** Kept for the window's life: a reload of its page is the same window, not another one. */
const KEY = "incarnamind.window";

function remembered(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** This window's id: a column change is keyed to the window that made it, for its own Undo. */
export const clientId = remembered() ?? crypto.randomUUID();

try {
  sessionStorage.setItem(KEY, clientId);
} catch {
  // Not kept, then: a reload counts as another window to the core. The first change that
  // waits for the old one reports it and the core drops it, so later changes don't wait.
}
