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
import {
  type CellFigurePlace,
  type KeptCitationText,
  MIND_CONTENT_FIELD,
  type UnreadFile,
} from "../../core/api";
import type { Language } from "../../core/language";
import { allOrigins } from "../../shared/blockOrigins";
import { citationState, type LiveDocument } from "../../shared/citations";
import { checkSearchedNarrowerThanAll } from "../../shared/claimChecks";
import { formatDateTime } from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { mindCheckOf } from "../../shared/mindCheck";
import { mindScopeOf } from "../../shared/mindScope";
import { checkUnreadOf } from "../../shared/unreadFiles";
import { claimsOf, figurePlacesOf, type ShownClaim } from "./editor/claimChecks";
import { type NoteHealth, noteHealth } from "./editor/healthCounts";
import { BLOCK_ID_ATTRIBUTE, noteExtensions } from "./editor/noteSchema";

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
  /** The files to name: the narrow-scope ones that keep it amber, or, in green, every file its checks couldn't read (#740, D261). */
  unread: number;
  /** Whether a file the checks couldn't read could hold evidence they looked for: one of them searched a scope narrower than all Documents. */
  unreadMatters: boolean;
  /** The claims a check reads: with none, there is nothing to say. */
  checkable: number;
}

/**
 * The state from `noteHealth` alone. Null when a check reads nothing: a note of headings, or
 * one whose every sentence is kept as the User's view, has nothing to show. A claim a check
 * failed, that no longer holds, or is checking right now is "Not checked": nothing has checked
 * it since its last edit, and a run in flight is never done. Unread files that could hold the
 * evidence — a check searched a scope narrower than all Documents — keep the state amber and are
 * named; files only a search of all Documents couldn't read stay in the green's count.
 */
export function noteStateOf(health: NoteHealth, unread = 0, narrowUnread = 0): NoteState | null {
  const unreadMatters = narrowUnread > 0;
  if (health.checkable === 0) return null;
  const look = health.lookClaims.length;
  const base = {
    checkedAt: health.checkedAt,
    unread: 0,
    unreadMatters: false,
    checkable: health.checkable,
  };
  if (health.contradicted.length > 0) {
    return {
      ...base,
      kind: "needs-look",
      look,
      tone: "error",
      mark: "contradicted",
      unread: narrowUnread,
      unreadMatters,
    };
  }
  if (look > 0) {
    const mark: NoteStateMark = health.unsupported.length > 0 ? "unsupported" : "notFound";
    return {
      ...base,
      kind: "needs-look",
      look,
      tone: "warning",
      mark,
      unread: narrowUnread,
      unreadMatters,
    };
  }
  if (health.checking.length > 0 || health.toCheck.length > 0) {
    const mark: NoteStateMark = health.recheck.length > 0 ? "recheck" : "notChecked";
    return { ...base, kind: "not-checked", look: 0, tone: "neutral", mark };
  }
  if (unreadMatters) {
    return {
      ...base,
      kind: "needs-look",
      look: 0,
      tone: "warning",
      mark: "notChecked",
      unread: narrowUnread,
      unreadMatters,
    };
  }
  return { ...base, kind: "checked", look: 0, tone: "success", mark: "checked", unread };
}

/** The checks that looked in a scope narrower than all Documents: a Folder, a Tag, or Documents the User picked. */
function narrowRequestsOf(claims: readonly ShownClaim[]): string[] {
  return [
    ...new Set(
      claims
        .filter((claim) => checkSearchedNarrowerThanAll(claim.check.scope))
        .map((claim) => claim.check.request)
        .filter((request) => request !== ""),
    ),
  ];
}

/**
 * The files the check card's unread line names: only those that keep the Note amber, or every
 * file its checks couldn't read when they don't (D261).
 */
export function unreadForCard(
  all: readonly UnreadFile[],
  narrow: readonly UnreadFile[],
  state: NoteState | null,
): readonly UnreadFile[] {
  return state?.unreadMatters === true ? narrow : all;
}

export type NoteReading = ReturnType<typeof readNoteState>;

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The state's words, part by part: "Checked 14:25", "3 files couldn't be read" (#740, D261). */
export function noteStateParts(
  state: NoteState,
  t: Translate,
  language: Language,
  now?: Date,
): readonly string[] {
  const count = (value: number) => new Intl.NumberFormat(language).format(value);
  const unreadWords = () =>
    t(state.unread === 1 ? "unread.count.one" : "unread.count", { count: count(state.unread) });
  if (state.kind === "not-checked") return [t("health.state.notChecked")];
  if (state.kind === "needs-look") {
    const parts: string[] = [];
    if (state.look > 0) {
      parts.push(
        t(state.look === 1 ? "health.state.look.one" : "health.state.look", {
          count: count(state.look),
        }),
      );
    }
    if (state.unreadMatters && state.unread > 0) parts.push(unreadWords());
    return parts;
  }
  const time =
    state.checkedAt === null ? "" : formatDateTime(state.checkedAt, language, now ? { now } : {});
  const said = time === "" ? t("health.state.checked.noTime") : t("health.state.checked", { time });
  if (state.unread === 0) return [said];
  return [said, unreadWords()];
}

let schema: ReturnType<typeof getSchema> | undefined;

/**
 * A Mind's health and state from its Yjs document, as the editor reads them, for Home's rows
 * and the Export menu, and the Answers its live Blocks hold: a Block deleted since keeps its
 * origin, but the Answer it came from is no longer in the Mind. `documents` is null until the
 * live Documents are known: checks show as they were stored until then, as the editor does.
 */
export function readNoteState({
  doc,
  cellFigures,
  documents,
  keptCitationTexts,
  folderId,
}: {
  doc: Y.Doc;
  /** Where its table cells hold figures, as the core reads them (`MindContentSnapshot`). */
  cellFigures: readonly CellFigurePlace[];
  documents: readonly LiveDocument[] | null;
  keptCitationTexts: readonly KeptCitationText[];
  folderId: string | null;
}): { health: NoteHealth; state: NoteState | null; filedAnswers: ReadonlySet<string> } {
  schema ??= getSchema(noteExtensions());
  const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(MIND_CONTENT_FIELD), schema);
  const { claims, kept } = claimsOf(root, {
    versions:
      documents === null
        ? null
        : new Map(documents.map((document) => [document.id, document.contentHash])),
    folderId,
    scope: mindScopeOf(doc),
    figurePlaces: figurePlacesOf(cellFigures),
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
  const unread = checkUnreadOf(doc, requests).length;
  const narrowUnread = checkUnreadOf(doc, narrowRequestsOf(claims)).length;
  const origins = allOrigins(doc);
  const filedAnswers = new Set<string>();
  root.forEach((block) => {
    const id = block.attrs[BLOCK_ID_ATTRIBUTE];
    const reference = typeof id === "string" ? origins.get(id)?.from : undefined;
    if (reference?.artifactKind === "conversation" && reference.anchor.kind === "message") {
      filedAnswers.add(reference.anchor.messageId);
    }
  });
  return {
    health,
    state: noteStateOf(health, unread, narrowUnread),
    filedAnswers,
  };
}
