/**
 * What a tagging run proposes for each Document, from what its tagger decided (#2339): one kind,
 * the User's own Tags it is about, and a new topic Tag only where at least `TOPIC_SHARED`
 * Documents of the run share it, at most `TOPICS_PER_RUN` a run. A run of one Document, as
 * tagging in the background is, never proposes a new topic.
 */
import { kindOfId, type TagChoice } from "./classify";
import type { TagKind } from "./kinds";
import { tagKey } from "./suggest";

/** How many of a run's Documents must share a topic for it to be proposed as a new Tag. */
export const TOPIC_SHARED = 3;
/** The most new topic Tags one run proposes. */
export const TOPICS_PER_RUN = 3;

/** A Tag proposed for a Document: one of the Library's, a kind, or a new one by name. */
export type ProposedTag =
  | { tagId: string }
  | { kind: TagKind }
  | { name: string; description: string };

/** Each Document's proposed Tags, in the order of `choices`. */
export function proposedTags(choices: ReadonlyMap<string, TagChoice>): Map<string, ProposedTag[]> {
  const topics = new Map<string, { name: string; description: string; documents: string[] }>();
  for (const [documentId, choice] of choices) {
    for (const topic of choice.newTags.slice(0, 1)) {
      const key = tagKey(topic.name);
      const shared = topics.get(key);
      if (shared) shared.documents.push(documentId);
      else topics.set(key, { ...topic, documents: [documentId] });
    }
  }
  const chosen = [...topics.values()]
    .filter((topic) => topic.documents.length >= TOPIC_SHARED)
    .sort((a, b) => b.documents.length - a.documents.length)
    .slice(0, TOPICS_PER_RUN);
  const proposed = new Map<string, ProposedTag[]>();
  for (const [documentId, choice] of choices) {
    let kind: { kind: TagKind; confidence: number } | null = null;
    const tags: ProposedTag[] = [];
    for (const decision of choice.decisions) {
      const decided = kindOfId(decision.tagId);
      if (decided === null) {
        tags.push({ tagId: decision.tagId });
        continue;
      }
      const confidence = decision.confidence ?? 1;
      if (!kind || confidence > kind.confidence) kind = { kind: decided, confidence };
    }
    const topic = chosen.find((each) => each.documents.includes(documentId));
    proposed.set(documentId, [
      ...(kind ? [{ kind: kind.kind }] : []),
      ...tags,
      ...(topic ? [{ name: topic.name, description: topic.description }] : []),
    ]);
  }
  return proposed;
}
