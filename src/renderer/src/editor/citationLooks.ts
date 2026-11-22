import type { EditorView } from "@tiptap/pm/view";
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ChangedQuote, CitationCheck } from "../../../core/api";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import type { CommandContext } from "../commands/registry";

/**
 * What one Citation shows, as its own node view works it out: what the chip that stands for a
 * group of them (`CitationGroup`) draws and lists, each in its own state, with its own actions.
 */
export interface CitationLook {
  key: string;
  /** Its check as its marker shows it. */
  check: CitationCheck;
  /** Its Document has a newer version where its quote isn't as cited (#99). */
  recheck: boolean;
  /** Its card's state line. */
  badge: string;
  quote: string;
  /** The Units its quote is in: a chip opens its Document over all of its quotes'. */
  pageFrom: number | null;
  pageTo: number | null;
  /** How its quoted words read in the Document's newer version, when they changed there. */
  changed: ChangedQuote["parts"] | null;
  /** Its right-click menu's actions (`citation.*`). */
  here(): CommandContext["here"];
  /** The first way on its own card offers, when it needs a look ("Update the sentence…"). */
  fix: { label: string; run(): void } | null;
}

interface Looks {
  byKey: Map<string, CitationLook>;
  listeners: Set<() => void>;
}

const editors = new WeakMap<EditorView, Looks>();

const NO_LOOKS: readonly CitationLook[] = [];

function looksOf(view: EditorView): Looks {
  let looks = editors.get(view);
  if (!looks) {
    looks = { byKey: new Map(), listeners: new Set() };
    editors.set(view, looks);
  }
  return looks;
}

/** Puts a Citation's look where its group's chip reads it; the returned function takes it back. */
export function showLook(view: EditorView, look: CitationLook): () => void {
  const looks = looksOf(view);
  looks.byKey.set(look.key, look);
  for (const listener of looks.listeners) listener();
  return () => {
    if (looks.byKey.get(look.key) !== look) return;
    looks.byKey.delete(look.key);
    for (const listener of looks.listeners) listener();
  };
}

/** The looks of these Citations, in their order, as each node view last showed it. */
export function useCitationLooks(
  view: EditorView | null,
  keys: readonly string[],
): readonly CitationLook[] {
  const last = useRef<readonly CitationLook[]>([]);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!view) return () => {};
      const { listeners } = looksOf(view);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    [view],
  );
  const read = useCallback(() => {
    if (!view || keys.length === 0) {
      last.current = NO_LOOKS;
      return last.current;
    }
    const { byKey } = looksOf(view);
    const now = keys.flatMap((key) => byKey.get(key) ?? []);
    const same =
      now.length === last.current.length && now.every((each, at) => each === last.current[at]);
    if (!same) last.current = now;
    return last.current;
  }, [view, keys]);
  return useSyncExternalStore(subscribe, read);
}

/** How much a state asks of the User, so a chip for several shows the one that asks most. */
const WEIGHT: Record<CitationCheck, number> = {
  found: 0,
  checking: 1,
  "not-checked": 2,
  "cant-check": 3,
  "not-found": 5,
  unsupported: 6,
  contradicted: 7,
};

/** The look a group's chip takes: its worst Citation's, a re-check counting under a quote not found. */
export function worstLook(looks: readonly CitationLook[]): CitationLook | null {
  let worst: CitationLook | null = null;
  const weight = (look: CitationLook) => WEIGHT[look.check] + (look.recheck ? 3.5 : 0);
  for (const look of looks) if (!worst || weight(look) > weight(worst)) worst = look;
  return worst;
}

/** Its found state line in the plural, for a chip that stands for several quotes all found. */
const FOUND_FOR_SEVERAL: Partial<Record<MessageKey, MessageKey>> = {
  "citation.badge.found.on": "citation.group.found.on",
  "citation.badge.found.in": "citation.group.found.in",
  "citation.badge.found.document": "citation.group.found.document",
  "citation.badge.found.transcript": "citation.group.found.transcript",
};

/**
 * The state line of a chip that stands for several Citations: "3 quotes found in ¶ 19" when
 * all were, else the worst one's own line and how many share it: "Needs re-check · 1 of 3 quotes".
 */
export function groupBadgeText(
  members: readonly CitationLook[],
  worst: CitationLook | null,
  own: { key: MessageKey; params?: Record<string, string> },
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const count = members.length;
  const plural = FOUND_FOR_SEVERAL[own.key];
  if (!worst || (worst.check === "found" && !worst.recheck)) {
    return plural ? t(plural, { ...own.params, count }) : t(own.key, own.params);
  }
  const some = members.filter(
    (member) => member.check === worst.check && member.recheck === worst.recheck,
  ).length;
  return t("citation.group.some", { badge: worst.badge, some, count });
}
