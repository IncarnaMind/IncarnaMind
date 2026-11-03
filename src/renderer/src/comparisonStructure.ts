/**
 * A comparison table's structure changes: the core is the one writer, so a
 * window asks it with the table taking no local edits while it is written — a
 * local write can't cross the core's change (#1833, #1837).
 */
import type { Editor } from "@tiptap/core";
import { useComparisonColumns } from "./comparisonColumnState";
import { flushMindUpdates } from "./mindCopies";
import { useAppStore } from "./store";

/** The Mind and table a command acts on, and the editor showing it. */
export interface ComparisonTableHandle {
  editor: Editor;
  mindId: string;
  tableId: string;
}

export async function structure<T>(
  handle: ComparisonTableHandle,
  ask: () => Promise<T>,
): Promise<T | null> {
  await flushMindUpdates(handle.mindId);
  // This window holds the table at once; the core's broadcast holds it in every other window.
  const request = `window-${crypto.randomUUID()}`;
  useComparisonColumns.getState().hold(handle.tableId, request);
  try {
    return await ask();
  } catch (error) {
    useAppStore.getState().reportError(error);
    return null;
  } finally {
    useComparisonColumns.getState().release(handle.tableId, request);
  }
}
