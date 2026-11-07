import { MockLanguageModelV4 } from "ai/test";
import type { CoreApi } from "../../src/core/api";
import { isRecord } from "../../src/core/errors";

/**
 * A chat model for Organize: it files each Document in the first Folder it is offered, or
 * the one chosen, with the Tags chosen. `hold` keeps its answers back until `release`.
 */
export function classifierModel() {
  const calls: string[] = [];
  let chosen: string | undefined;
  let selectedTags: string[] = [];
  let gate: Promise<void> | null = null;
  let release = () => {};
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const schema =
        options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
      const group = (schema as { properties?: { groupId?: { enum: string[] } } } | undefined)
        ?.properties?.groupId;
      let text = JSON.stringify({ tags: [] });
      if (group) {
        calls.push(JSON.stringify(options.prompt));
        const choice = chosen ?? group.enum[0];
        const tagIds = selectedTags;
        if (gate) await gate;
        text = JSON.stringify({ groupId: choice, tags: tagIds });
      }
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        warnings: [],
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      };
    },
  });
  return {
    model,
    calls,
    tag: (ids: string[]) => {
      selectedTags = ids;
    },
    choose: (id: string) => {
      chosen = id;
    },
    hold() {
      gate = new Promise((resolve) => {
        release = resolve;
      });
    },
    release() {
      gate = null;
      release();
    },
  };
}

/**
 * Where Organize proposes a Document goes, as Suggestions hold it (#1569): a live Folder's id, a
 * Folder proposed by name as "new:{name}", "left out", or null when nothing waits for it.
 */
export async function proposedFor(core: Pick<CoreApi, "getOrganizeReview">, documentId: string) {
  const review = await core.getOrganizeReview();
  const item = review.items.find((each) => each.documentId === documentId);
  if (!item) return null;
  const { placement } = item;
  if (placement.kind === "folder") return placement.folderId;
  if (placement.kind === "newFolder")
    return `new:${review.folders.find((folder) => folder.id === placement.newFolderId)?.name}`;
  return placement.kind === "leftOut" ? "left out" : null;
}

/**
 * A scripted model's reply to the plan's requests (#1569), putting every Document in the one
 * Folder of this name: proposed by the sort when the Library has none, chosen by a placement.
 * Null for any other request; `documents` is how many it was sent.
 */
export function planReply(
  prompt: string,
  folder: { name: string; description: string },
): { text: string; documents: number } | null {
  let data: unknown;
  try {
    data = JSON.parse(prompt);
  } catch {
    return null;
  }
  if (!isRecord(data) || !Array.isArray(data.documents) || !Array.isArray(data.folders))
    return null;
  const refs = data.documents.flatMap((each) =>
    isRecord(each) && typeof each.ref === "string" ? [each.ref] : [],
  );
  if (refs.length === 0) return null;
  const known = data.folders.find(
    (each) => isRecord(each) && typeof each.name === "string" && each.name.endsWith(folder.name),
  );
  const id = isRecord(known) && typeof known.id === "string" ? known.id : "";
  const key = id || "N1";
  const reply =
    "language" in data
      ? {
          folders: [{ key, name: id ? "" : folder.name, description: folder.description }],
          documents: refs.map((ref) => ({ ref, folder: key })),
        }
      : { placements: refs.map((ref) => ({ ref, folder: id || "none" })) };
  return { text: JSON.stringify(reply), documents: refs.length };
}
