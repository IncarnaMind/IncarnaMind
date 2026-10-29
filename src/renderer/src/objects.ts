import type { MessageKey, MessageParams } from "../../shared/i18n";
import type { Undoable } from "./undo";

/**
 * The kinds of thing the User works with, the same for every gesture: menus, selection,
 * drag and ⌘K. A conversation is the assistant's, never a Mind (ADR-0017). Listed, not
 * only typed, so the conformance checks can walk them (tests/renderer/conformance.test.ts).
 */
export const OBJECT_KINDS = [
  "mind",
  "conversation",
  "document",
  "folder",
  "tag",
  "linkedFolder",
  "deleted",
  "citation",
  "chart",
  "comparisonColumn",
  "comparisonTable",
  "comparisonRow",
  "answer",
  "check",
  "block",
  "tab",
] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];

export interface ObjectRef {
  kind: ObjectKind;
  id: string;
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export type { Undoable };
