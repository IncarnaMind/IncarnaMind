/**
 * What the Tag picker and a Document's chips show, worked out from the Tags
 * and the Documents' links. Pure: no store, no bridge, so the tests import it.
 */
import type { Document, DocumentTag, Tag } from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { unitsOf } from "../../shared/i18n/join";
import { matchName, queryWords } from "./matcher";

/** How a Tag stands on the Documents being edited. */
export interface TagOnDocuments {
  tag: Tag;
  /** On all of them, some, or none. */
  coverage: "all" | "some" | "none";
  /** How many of them carry it, of `total`. */
  count: number;
  total: number;
  /** Every link to it is automatic tagging's. */
  automatic: boolean;
  /** Automatic tagging's confidence, on a single Document; otherwise null. */
  confidence: number | null;
}

/** What choosing a Tag in the picker does. */
export type TagAction = "add" | "remove";

export function tagsOnDocuments(
  tags: readonly Tag[],
  documents: readonly Pick<Document, "tags">[],
): TagOnDocuments[] {
  return tags.map((tag) => {
    const links = documents.flatMap((document) =>
      document.tags.filter((link) => link.tagId === tag.id),
    );
    const count = links.length;
    return {
      tag,
      coverage: count === 0 ? "none" : count === documents.length ? "all" : "some",
      count,
      total: documents.length,
      automatic: count > 0 && links.every((link) => link.source === "automatic"),
      confidence: documents.length === 1 ? (links[0]?.confidence ?? null) : null,
    };
  });
}

/**
 * Choosing a Tag adds it where it's missing (to all, when only some have
 * it), and takes it off when every Document has it.
 */
export function actionFor(state: TagOnDocuments): TagAction {
  return state.coverage === "all" ? "remove" : "add";
}

const fold = (text: string) => text.trim().toLocaleLowerCase();

/**
 * The Tags `query` finds by name, the closest first, a Chinese name by its
 * pinyin too (the matcher ⌘K uses); and the name to create, if nothing is
 * named exactly that.
 */
export function pickerOptions(
  states: readonly TagOnDocuments[],
  query: string,
): { matches: TagOnDocuments[]; create: string | null } {
  const words = queryWords(query);
  if (words.length === 0) return { matches: [...states], create: null };
  const matches = states
    .flatMap((state, index) => {
      const match = matchName(words, state.tag.name);
      return match && !match.typo ? [{ state, index, match }] : [];
    })
    .sort((a, b) => b.match.score - a.match.score || a.index - b.index)
    .map(({ state }) => state);
  const wanted = fold(query);
  const exists = states.some((state) => fold(state.tag.name) === wanted);
  return { matches, create: exists ? null : query.trim() };
}

/**
 * A Document's Tags as chips, in the order of its links (name order). The
 * Tags may come indexed by id (`tagIndex`), so a list of many Documents looks
 * each up without building the index again.
 */
export function chipsOf(
  links: readonly DocumentTag[],
  tags: readonly Tag[] | ReadonlyMap<string, Tag>,
): { tag: Tag; link: DocumentTag }[] {
  const byId = "get" in tags ? tags : tagIndex(tags);
  return links.flatMap((link) => {
    const tag = byId.get(link.tagId);
    return tag ? [{ tag, link }] : [];
  });
}

/** The Tags by id. */
export const tagIndex = (tags: readonly Tag[]): ReadonlyMap<string, Tag> =>
  new Map(tags.map((tag) => [tag.id, tag]));

type Translate = (key: MessageKey, params?: MessageParams) => string;
type NamedChip = { tag: Pick<Tag, "name"> };

const namesOf = (chips: readonly NamedChip[], language: Language) =>
  unitsOf(
    chips.map(({ tag }) => tag.name),
    language,
  );

/** What a Document's row says of the Tags it carries: "Tags: Q3, Q4"; "标签：Q3、Q4". */
export const tagMarksLine = (t: Translate, language: Language, chips: readonly NamedChip[]) =>
  t("tags.marks", { names: namesOf(chips, language) });

/** What "+N" says of the Tags it hides: "2 more: Q3, Q4"; "另有 2 个：Q3、Q4". */
export const hiddenTagsLine = (t: Translate, language: Language, hidden: readonly NamedChip[]) =>
  t("tags.chip.more", { count: hidden.length, names: namesOf(hidden, language) });
