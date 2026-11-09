/**
 * Tag with AI from the assistant (#2339): the Library's Re-tag on the Documents named or found, or
 * every one of the User's. Nothing is added from the chat: the Tags it proposes wait in Suggested
 * Tags, the app writes the reply, as for Organize, since a model that narrates them says "added",
 * and the reply's Review button opens them. Its Undo takes its proposals back out. It goes through
 * the tagging flow, which asks nothing: without its consent for the service, it fails and says so.
 */
import { translate } from "../../../shared/i18n";
import type { OrganizeReviewChange } from "../../api";
import type { Language } from "../../language";
import { type Checker, documentItem, documentsOf, inApp, plural } from "./run";

/** What the model reads once the Tags were proposed: the app has said so, so it leaves tagging out. */
const LEAVE_TAGGING_OUT =
  "IncarnaMind has already shown the User what Tag with AI proposed, in its own words. Your reply leaves tagging out entirely, as if it had not been asked: no word about Tags.";
const tagsShown = (alsoAsked: string | null) =>
  alsoAsked === null
    ? `${LEAVE_TAGGING_OUT} If the User asked for nothing else, write nothing.`
    : `${LEAVE_TAGGING_OUT} Answer the rest of the request, as its call put it: “${alsoAsked}”`;

/** What Tag with AI proposed, as the reply says it in `language`: the app writes it, not the model. */
export function proposedTagsText(
  language: Language,
  documents: number,
  tags: readonly { name: string; count: number }[],
): string {
  const proposed = translate(language, "answer.commands.proposedTags", {
    documents: translate(
      language,
      documents === 1 ? "organizeReview.documents.one" : "organizeReview.documents",
      { count: documents },
    ),
    parts: tags
      .map((tag) =>
        translate(language, "answer.commands.proposed.part", {
          folder: tag.name,
          count: tag.count,
        }),
      )
      .join(translate(language, "answer.commands.proposed.separator")),
  });
  const wait = translate(
    language,
    documents === 1 ? "answer.commands.proposedTags.wait.one" : "answer.commands.proposedTags.wait",
  );
  return language === "zh-CN" ? `${proposed}${wait}` : `${proposed} ${wait}`;
}

export const tagWithAiChecker: Checker = async (input, host, place) => {
  const { core } = host;
  // With none named, it takes what the turn may see, its wall's or those outside every wall, and
  // of those only where tagging is on and not stopped, as Re-tag all does (#2308).
  const everyOne = input.ids.length === 0;
  const seen = everyOne
    ? (
        await Promise.all(
          (
            await place.findable()
          ).documents.map(async (each) =>
            each.meetingMindId === null && !(await core.isExampleDocument(each.id)) ? [each] : [],
          ),
        )
      ).flat()
    : await documentsOf(core, input.ids);
  const documents = everyOne ? seen.filter((each) => host.taggingOn(each.id)) : seen;
  const items = documents.map((each) => documentItem(each));
  const ids = documents.map((each) => each.id);
  return {
    ...inApp(
      "documents.tagWithAi",
      items,
      null,
      async (_asking, signal) => {
        if (ids.length === 0)
          return {
            done: { items: [] },
            step: null,
            said:
              seen.length === 0
                ? "There is no Document to tag."
                : "Tagging is off, or the User stopped it where these Documents are: nothing was sent, and nothing changed.",
          };
        const runId = crypto.randomUUID();
        const before = new Set((await core.getOrganizeReview()).items.map((item) => item.id));
        const result = await host.tagByRun(ids, signal, runId);
        if (result.status !== "done")
          return {
            done: { items: [] },
            step: null,
            said: "Tagging stopped before it proposed anything. Nothing changed.",
          };
        const review = await core.getOrganizeReview();
        const wanted = new Set(ids);
        const fresh = review.items.filter(
          (item) => wanted.has(item.documentId) && !before.has(item.id),
        );
        const tagged = fresh.filter((item) => item.tags.length > 0);
        const unreached = fresh.flatMap(({ placement }) => {
          const leftOut = placement.kind === "leftOut" ? placement.leftOut : null;
          return leftOut?.reason === "unreachable" ? [leftOut.service] : [];
        });
        const counts = new Map<string, { name: string; count: number }>();
        for (const item of tagged)
          for (const tag of item.tags) {
            const was = counts.get(tag.name);
            counts.set(tag.name, { name: tag.name, count: (was?.count ?? 0) + 1 });
          }
        let withdrawn: OrganizeReviewChange | null = null;
        return {
          done: {
            items: tagged.map((item) => {
              const document = documents.find((each) => each.id === item.documentId);
              return document
                ? documentItem(document)
                : { kind: "document" as const, id: item.documentId, name: item.documentId };
            }),
            tags: [...counts.values()].sort((a, b) => b.count - a.count),
            considered: ids.length,
            review: { count: review.count },
            ...(input.alsoAsked !== null && { alsoAsked: input.alsoAsked }),
          },
          step:
            fresh.length === 0
              ? null
              : {
                  undo: async () => {
                    withdrawn = host.withdrawOrganizeRun(runId, []);
                    return null;
                  },
                  redo: async () => {
                    // Its proposals come back as they were: Redo never asks the model again.
                    if (withdrawn)
                      await core.restoreOrganizeReview(withdrawn.before, withdrawn.after);
                    withdrawn = null;
                  },
                },
          ...(tagged.length > 0 && input.alsoAsked === null && { ends: true as const }),
          said:
            tagged.length > 0
              ? tagsShown(input.alsoAsked)
              : unreached.length > 0
                ? `Tag with AI couldn't reach ${unreached[0]} for ${plural(unreached.length, "Document")}, so it proposed no Tag for them. They wait in Left out to be tried again. No Tag was added.`
                : "Tag with AI proposed no Tag for any Document. Nothing changed.",
        };
      },
      documents.length > 0 ? "organize" : null,
    ),
    // Proposals add nothing, so they count towards no limit on the Answer's changes.
    changes: false,
  };
};
