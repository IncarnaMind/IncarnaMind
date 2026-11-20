/**
 * Whether a Document is about one of the User's Tags (#2339), tested on this computer before the
 * Tag is offered to the model: the Document's words against those of the Documents carrying the
 * Tag, weighted by how rare each word is in the Library. It is about the Tag's subject when it is
 * at least `ABOUT` alike to them, and more alike to them than to any other Document not on that
 * subject, so a Tag goes to a Document on its subject, not to one that mentions it or shares a
 * mood with it. A Tag on no Document yet goes by its own name and description.
 */
import { termsOf } from "../library/plan";
import type { Database } from "../storage";
import { excerptFromPassages, type TagDefinition } from "./classify";
import { TAG_KINDS, type TagKind } from "./kinds";
import { tagKey } from "./suggest";

/** How alike a Document and a Tag's Documents must be, as the cosine of their word weights. */
export const ABOUT = 0.1;
/** The most of a Tag's Documents it is measured against, the latest first. */
const MEMBERS = 10;
/** The other Documents that say how rare each word is. */
const BACKGROUND = 120;
/** How much of each Document's text is read, in tokens. */
const TEXT_TOKENS = 600;

type Weights = Map<string, number>;

const counts = (text: string) => {
  const count = new Map<string, number>();
  for (const term of termsOf(text)) count.set(term, (count.get(term) ?? 0) + 1);
  return count;
};

const cosine = (a: Weights, b: Weights) => {
  let shared = 0;
  for (const [term, weight] of a) shared += weight * (b.get(term) ?? 0);
  const length = (v: Weights) => Math.sqrt([...v.values()].reduce((sum, w) => sum + w * w, 0));
  const both = length(a) * length(b);
  return both === 0 ? 0 : shared / both;
};

/**
 * Of `tags`, those the Document whose text is `text` is about. Each Tag comes with the texts of
 * the Documents carrying it, this one left out; `background` is other Documents' text, for how
 * common each word is.
 */
export function tagsAbout(
  text: string,
  tags: readonly { tag: TagDefinition; texts: readonly string[]; rejected?: readonly string[] }[],
  background: readonly string[],
  rejectedTopics?: Map<string, string>,
): TagDefinition[] {
  const corpus = [text, ...tags.flatMap((each) => each.texts), ...background].map(counts);
  const holding = new Map<string, number>();
  for (const count of corpus)
    for (const term of count.keys()) holding.set(term, (holding.get(term) ?? 0) + 1);
  const weigh = (count: Map<string, number>): Weights => {
    const weights: Weights = new Map();
    for (const [term, times] of count) {
      const idf = Math.log((corpus.length + 1) / ((holding.get(term) ?? 0) + 1)) + 1;
      weights.set(term, (1 + Math.log(times)) * idf);
    }
    return weights;
  };
  const subject = counts(text);
  const own = weigh(subject);
  return tags.flatMap(({ tag, texts, rejected = [] }) => {
    if (rejected.length) {
      // A correction competes with the nearest example the User kept, or the Tag's definition alone.
      const support = [`${tag.name} ${tag.description}`, ...texts];
      const closest = Math.max(...support.map((example) => cosine(own, weigh(counts(example)))));
      if (
        rejected.some((example) => {
          const similarity = cosine(own, weigh(counts(example)));
          return similarity > 0 && similarity >= closest;
        })
      ) {
        rejectedTopics?.set(tagKey(tag.name), tag.id);
        return [];
      }
    }
    if (texts.length === 0) {
      const named = termsOf(`${tag.name} ${tag.description}`);
      return termsOf(tag.name).some((term) => subject.has(term)) ||
        named.filter((term) => subject.has(term)).length >= 3
        ? [tag]
        : [];
    }
    const centre: Weights = new Map();
    for (const member of texts)
      for (const [term, weight] of weigh(counts(member)))
        centre.set(term, (centre.get(term) ?? 0) + weight / texts.length);
    const alike = cosine(own, centre);
    if (alike < ABOUT) return [];
    // A Document that only mentions the subject is closer to some other Document of the Library
    // than to the Tag's. One on the subject that no one tagged yet doesn't count against it.
    const rivals = background
      .filter((other) => other !== text && !texts.includes(other))
      .map((other) => weigh(counts(other)))
      .filter((other) => cosine(other, centre) < ABOUT);
    return rivals.every((other) => cosine(own, other) < alike) ? [tag] : [];
  });
}

const textOf = (db: Database, documentId: string) =>
  excerptFromPassages(
    db
      .all<{ text: string }>(
        "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position LIMIT 6",
        [documentId],
      )
      .map((row) => row.text),
    TEXT_TOKENS,
  );

/**
 * The User's own Tags: those they made or changed, and those they put on a Document or confirmed;
 * never a kind, and never a Tag only tagging made and no one confirmed.
 */
export function ownTags(db: Database): TagDefinition[] {
  return db.all<TagDefinition>(
    `SELECT t.id, t.name, t.description FROM tags t
     WHERE t.deleted_at IS NULL AND t.kind IS NULL AND (t.made_by_user = 1 OR EXISTS (
       SELECT 1 FROM document_tags l WHERE l.tag_id = t.id AND l.source = 'user' AND l.deleted_at IS NULL))
     ORDER BY t.name COLLATE NOCASE, t.created_at, t.rowid`,
  );
}

/**
 * The kinds tagging may propose: all but one whose Tag the User deleted. A kind that never had a
 * Tag here, as after an update brings new kinds, is made one on Confirm.
 */
export function offeredKinds(db: Database): TagKind[] {
  const withdrawn = new Set(
    db
      .all<{ kind: string }>(
        `SELECT DISTINCT d.kind FROM tags d
         WHERE d.kind IS NOT NULL AND d.deleted_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM tags l WHERE l.kind = d.kind AND l.deleted_at IS NULL)`,
      )
      .map((row) => row.kind),
  );
  return TAG_KINDS.filter((kind) => !withdrawn.has(kind));
}

export type TagsOfferedTo = (
  ids: readonly string[],
  own?: readonly TagDefinition[],
  known?: ReadonlyMap<string, string>,
) => TagOffers;

interface TagOffers {
  offered: Map<string, TagDefinition[]>;
  rejectedTopics: Map<string, Map<string, string>>;
}

/**
 * The User's own Tags these Documents are about, each Document's own: what tagging may offer
 * the model for it. `own`: the User's Tags, read once for a run.
 */
export function offeredTags(
  db: Database,
  documentIds: readonly string[],
  at: string,
  documentWalls: () => ReadonlyMap<string, readonly string[]>,
  own: readonly TagDefinition[] = ownTags(db),
  /** Text the caller has read for a Document, as a scan's first pages before it is stored. */
  known: ReadonlyMap<string, string> = new Map(),
): TagOffers {
  const rejectedTopics = new Map<string, Map<string, string>>();
  const offered = new Map<string, TagDefinition[]>();
  if (own.length === 0) {
    for (const id of documentIds) offered.set(id, []);
    return { offered, rejectedTopics };
  }
  const membersOf = new Map(
    own.map((tag) => [
      tag.id,
      db
        .all<{ document_id: string }>(
          `SELECT l.document_id FROM document_tags l JOIN documents d ON d.id = l.document_id
           WHERE l.tag_id = ? AND l.deleted_at IS NULL AND d.deleted_at IS NULL
           ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`,
          [tag.id, BigInt(MEMBERS + 1)],
        )
        .map((row) => row.document_id),
    ]),
  );
  const corrections = db.all<{ target_id: string; document_id: string }>(
    `SELECT r.target_id, r.document_id FROM organize_review_declines r
     JOIN documents d ON d.id = r.document_id AND d.content_hash = r.rejected_content_hash
     WHERE r.rejected_content_hash IS NOT NULL AND r.deleted_at IS NULL AND r.until > ?
       AND d.deleted_at IS NULL AND d.meeting_mind_id IS NULL
       AND r.target_id IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (SELECT 1 FROM document_tags l WHERE l.tag_id = r.target_id
         AND l.document_id = r.document_id AND l.deleted_at IS NULL)
     ORDER BY r.created_at DESC, r.rowid DESC`,
    [at, JSON.stringify(own.map((tag) => tag.id))],
  );
  const walls = corrections.length ? documentWalls() : null;
  const scopeOf = (id: string) => JSON.stringify(walls?.get(id) ?? []);
  const rejectedByWall = new Map<string, Map<string, Set<string>>>();
  for (const row of corrections) {
    const wall = scopeOf(row.document_id);
    const byTag = rejectedByWall.get(wall) ?? new Map<string, Set<string>>();
    const ids = byTag.get(row.target_id) ?? new Set<string>();
    if (ids.size < MEMBERS) ids.add(row.document_id);
    byTag.set(row.target_id, ids);
    rejectedByWall.set(wall, byTag);
  }
  const texts = new Map<string, string>(known);
  const read = (id: string) => {
    let text = texts.get(id);
    if (text === undefined) {
      text = textOf(db, id);
      texts.set(id, text);
    }
    return text;
  };
  const background = db
    .all<{ id: string }>(
      `SELECT id FROM documents WHERE deleted_at IS NULL AND meeting_mind_id IS NULL
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [BigInt(BACKGROUND)],
    )
    .map((row) => read(row.id));
  for (const id of documentIds) {
    const rejected = rejectedByWall.size ? rejectedByWall.get(scopeOf(id)) : undefined;
    const rejectedHere = new Map<string, string>();
    offered.set(
      id,
      tagsAbout(
        read(id),
        own.map((tag) => ({
          tag,
          rejected: Array.from(rejected?.get(tag.id) ?? [], read).filter(Boolean),
          texts: (membersOf.get(tag.id) ?? [])
            .filter((member) => member !== id)
            .slice(0, MEMBERS)
            .map(read),
        })),
        background,
        rejectedHere,
      ),
    );
    if (rejectedHere.size) rejectedTopics.set(id, rejectedHere);
  }
  return { offered, rejectedTopics };
}
