/**
 * Whether a note is done (D266, #1915), one rule for the corner badge, Home's Recent row and
 * the Export menu: "Not checked" while a claim has no check (none yet, one that failed, or
 * one that no longer holds), "{n} need a look" while a check found a problem, and "Checked
 * {time}" once every claim is covered, naming the files the checks couldn't read. It reads
 * `noteHealth`, the one count (#1909). A sentence kept as the User's view counts as handled
 * and is named in the card.
 */
import { getSchema } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { type KeptCitationText, MIND_CONTENT_FIELD } from "../../core/api";
import type { Language } from "../../core/language";
import { citationState, type LiveDocument } from "../../shared/citations";
import { formatDateTime } from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { mindCheckOf } from "../../shared/mindCheck";
import { mindScopeOf } from "../../shared/mindScope";
import { checkUnreadOf } from "../../shared/unreadFiles";
import { claimsOf } from "./editor/claimChecks";
import { type NoteHealth, noteHealth } from "./editor/healthCounts";
import { noteExtensions } from "./editor/noteSchema";

export type NoteStateKind = "not-checked" | "needs-look" | "checked";

/** The mark the state speaks for: the worst of what it found, as the margin draws it. */
export type NoteStateMark =
  | "contradicted"
  | "unsupported"
  | "notFound"
  | "notChecked"
  | "recheck"
  | "checked";

export interface NoteState {
  kind: NoteStateKind;
  /** The claims that need a look: unsupported, contradicted, or a Citation not found. */
  look: number;
  tone: "neutral" | "warning" | "error" | "success";
  mark: NoteStateMark;
  /** The newest check among the claims that now hold (ISO 8601): the green's time. */
  checkedAt: string | null;
  /** The files its checks couldn't read, what the green doesn't cover (#740, D261). */
  unread: number;
  /** The claims a check reads: with none, there is nothing to say. */
  checkable: number;
}

/**
 * The state from `noteHealth` alone. Null when a check reads nothing: a note of headings, or
 * one whose every sentence is kept as the User's view, has nothing to show. A claim a check
 * failed or that no longer holds is "Not checked": nothing has checked it since its last edit.
 */
export function noteStateOf(health: NoteHealth, unread = 0): NoteState | null {
  if (health.checkable === 0) return null;
  const look = health.unsupported.length + health.contradicted.length + health.notFound.length;
  const base = { checkedAt: health.checkedAt, unread: 0, checkable: health.checkable };
  if (health.contradicted.length > 0) {
    return { ...base, kind: "needs-look", look, tone: "error", mark: "contradicted" };
  }
  if (look > 0) {
    const mark: NoteStateMark = health.unsupported.length > 0 ? "unsupported" : "notFound";
    return { ...base, kind: "needs-look", look, tone: "warning", mark };
  }
  if (health.toCheck.length > 0) {
    const mark: NoteStateMark = health.recheck.length > 0 ? "recheck" : "notChecked";
    return { ...base, kind: "not-checked", look: 0, tone: "neutral", mark };
  }
  return { ...base, kind: "checked", look: 0, tone: "success", mark: "checked", unread };
}

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The state's words, part by part: "Checked 14:25", "3 files couldn't be read" (#740, D261). */
export function noteStateParts(
  state: NoteState,
  t: Translate,
  language: Language,
  now?: Date,
): readonly string[] {
  if (state.kind === "not-checked") return [t("health.state.notChecked")];
  if (state.kind === "needs-look") {
    const count = new Intl.NumberFormat(language).format(state.look);
    return [t(state.look === 1 ? "health.state.look.one" : "health.state.look", { count })];
  }
  const time =
    state.checkedAt === null ? "" : formatDateTime(state.checkedAt, language, now ? { now } : {});
  const said = time === "" ? t("health.state.checked.noTime") : t("health.state.checked", { time });
  if (state.unread === 0) return [said];
  const count = new Intl.NumberFormat(language).format(state.unread);
  return [said, t(state.unread === 1 ? "unread.count.one" : "unread.count", { count })];
}

let schema: ReturnType<typeof getSchema> | undefined;

/**
 * A Mind's health and state from its Yjs document, as the editor reads them, for Home's rows
 * and the Export menu. `documents` is null until the live Documents are known: checks show as
 * they were stored until then, as the editor does.
 */
export function readNoteState({
  doc,
  documents,
  keptCitationTexts,
  folderId,
}: {
  doc: Y.Doc;
  documents: readonly LiveDocument[] | null;
  keptCitationTexts: readonly KeptCitationText[];
  folderId: string | null;
}): { health: NoteHealth; state: NoteState | null } {
  schema ??= getSchema(noteExtensions());
  const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(MIND_CONTENT_FIELD), schema);
  const { claims, kept } = claimsOf(root, {
    versions:
      documents === null
        ? null
        : new Map(documents.map((document) => [document.id, document.contentHash])),
    folderId,
    scope: mindScopeOf(doc),
  });
  const health = noteHealth(root, {
    claims,
    kept,
    skipped: new Set(mindCheckOf(doc)?.skipped ?? []),
    citationCheck: (attributes) => citationState(attributes, documents, keptCitationTexts).check,
  });
  const requests = new Set(
    claims.map((claim) => claim.check.request).filter((request) => request !== ""),
  );
  return { health, state: noteStateOf(health, checkUnreadOf(doc, requests).length) };
}
