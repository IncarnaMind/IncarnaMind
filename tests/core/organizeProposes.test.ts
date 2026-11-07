/**
 * Every Organize run proposes and files nothing (#1569): the Library's run, a Folder's run and
 * new Documents sorted in the background each write into Suggestions, and no Folder is made. A
 * run the User starts replaces rows they haven't edited; a Document the User filed moves only in
 * a run on its Folder; what the User turned down waits 30 days. Migration 136 moves suggestions
 * from before into Suggestions. Through the core's public interface, with a scripted model.
 */
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { type Core, DATABASE_FILE, type OrganizeReviewItem } from "../../src/core";
import { METADATA_VERSION, PROCESSING_VERSION } from "../../src/core/documents/processing";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, sha256, writeSourceFile } from "../helpers/documents";
import { proposedFor } from "../helpers/library";
import { scriptedModels } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const DAY = 24 * 60 * 60 * 1000;

const userText = (options: LanguageModelV4CallOptions) =>
  options.prompt
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n");

/**
 * Proposes "Kitchen" and "Race" when asked for Folders, and chooses for each Document the Folder
 * its name begins with, or none; it records every Organize request.
 */
function organizer() {
  const requests: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const schema = (
        options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined
      ) as { properties?: Record<string, unknown> } | undefined;
      let reply: unknown = { tags: [], newTags: [] };
      if (schema?.properties?.folders) {
        reply = {
          folders: [
            { name: "Kitchen", description: "The kitchen renovation." },
            { name: "Race", description: "The marathon." },
          ],
        };
      } else if (schema?.properties?.groupId) {
        const text = userText(options);
        requests.push(text);
        const data = JSON.parse(text) as {
          groups: { id: string; name: string }[];
          document: { name: string };
        };
        const group = data.groups.find((each) => data.document.name.startsWith(each.name));
        reply = { groupId: group?.id ?? "__unsorted__", tags: [], newTags: [] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }],
        finishReason: { unified: "stop", raw: undefined },
        warnings: [],
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      };
    },
  });
  return { model, requests };
}

/** A Library with Organize on a model on this computer, and the Folders asked for. */
async function start({
  automatic = false,
  folders = true,
  now,
  dataDir,
}: {
  automatic?: boolean;
  folders?: boolean;
  now?: () => Date;
  dataDir?: string;
} = {}) {
  const sorting = organizer();
  const directory = dataDir ?? (await createTempDataFolder());
  const createChatModel = scriptedModels(sorting.model).createChatModel;
  const core = startCore(directory, { createChatModel, ...(now && { now }) });
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const kitchen = folders
    ? await core.createLibraryGroup({ name: "Kitchen", description: "The kitchen renovation." })
    : null;
  const race = folders
    ? await core.createLibraryGroup({ name: "Race", description: "The marathon." })
    : null;
  await core.saveLibrarySettings({
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "local-model" } },
    automatic,
  });
  const sources = await createSourceFolder();
  const add = async (...names: string[]) =>
    addAndProcess(
      core,
      await Promise.all(
        names.map((name) => writeSourceFile(sources, `${name}.txt`, `${name}: a few words.`)),
      ),
    );
  return { core, dataDir: directory, sorting, kitchen, race, add, createChatModel };
}

const assignmentOf = async (core: Core, documentId: string) =>
  (await core.getLibrary()).assignments.find((each) => each.documentId === documentId);

const rowOf = async (core: Core, documentId: string): Promise<OrganizeReviewItem> => {
  const row = (await core.getOrganizeReview()).items.find((each) => each.documentId === documentId);
  if (!row) throw new Error("Nothing waits for it.");
  return row;
};

/** Waits until Organize has read these Documents again, after `asked` requests. */
const readAgain = async (
  core: Core,
  sorting: ReturnType<typeof organizer>,
  ids: readonly string[],
  asked: number,
) => {
  await vi.waitFor(() =>
    expect(sorting.requests.length).toBeGreaterThanOrEqual(asked + ids.length),
  );
  await vi.waitFor(async () => {
    for (const id of ids) expect((await assignmentOf(core, id))?.status).toBe("classified");
  });
};

describe("Every Organize run proposes, and files nothing", () => {
  test("the Library's Organize proposes a Folder for each, or leaves it out, and files and makes none", async () => {
    const { core, sorting, kitchen, race, add } = await start();
    const [quote, plan, letter] = await add("Kitchen quote", "Race plan", "Tax letter");
    if (!quote || !plan || !letter) throw new Error("Not added.");
    const counts: number[] = [];
    core.on("organizeReview.changed", ({ count }) => counts.push(count));

    await core.classifyDocuments([quote.id, plan.id, letter.id]);
    await readAgain(core, sorting, [quote.id, plan.id, letter.id], 0);

    const placements = await Promise.all(
      [quote, plan, letter].map(async (each) => {
        const row = await rowOf(core, each.id);
        return [each.name, row.placement, row.origin];
      }),
    );
    expect(placements).toEqual([
      ["Kitchen quote", { kind: "folder", folderId: kitchen?.id }, "library"],
      ["Race plan", { kind: "folder", folderId: race?.id }, "library"],
      ["Tax letter", { kind: "leftOut", leftOut: { reason: "doesntFit" } }, "library"],
    ]);
    const library = await core.getLibrary();
    expect(library.reviewCount).toBe(2);
    expect(counts.at(-1)).toBe(2);
    expect(library.assignments.map((each) => each.groupId)).toEqual([null, null, null]);
    expect(library.groups.map((each) => each.name)).toEqual(["Kitchen", "Race"]);
  });

  test("with no Folders, the Folders it proposes wait with the Documents, and none is made", async () => {
    const { core, add } = await start({ folders: false });
    const [quote, plan] = await add("Kitchen quote", "Race plan");
    if (!quote || !plan) throw new Error("Not added.");

    const proposed = await core.proposeFolders([quote.id, plan.id]);
    await core.classifyDocuments([quote.id, plan.id]);

    expect(proposed.map((each) => each.name)).toEqual(["Kitchen", "Race"]);
    await vi.waitFor(async () => {
      expect(await proposedFor(core, quote.id)).toBe("new:Kitchen");
      expect(await proposedFor(core, plan.id)).toBe("new:Race");
    });
    expect((await core.getLibrary()).groups).toEqual([]);
  });

  test("a Folder's Organize may propose moving what the User filed in it; the Library's leaves it", async () => {
    const { core, sorting, kitchen, race, add } = await start();
    const [plan] = await add("Race plan");
    if (!plan || !kitchen || !race) throw new Error("Not set up.");
    await core.assignDocumentGroup(plan.id, kitchen.id);

    await core.classifyDocuments([plan.id]);
    await readAgain(core, sorting, [plan.id], 0);
    expect(await proposedFor(core, plan.id)).toBeNull();

    await core.classifyDocuments([plan.id], { folderId: kitchen.id });
    await vi.waitFor(async () => expect(await proposedFor(core, plan.id)).toBe(race.id));
    expect((await rowOf(core, plan.id)).origin).toBe("folder");
    expect(await assignmentOf(core, plan.id)).toMatchObject({
      groupId: kitchen.id,
      source: "user",
    });
  });

  test("a new Document sorted in the background is proposed, and a run the User starts replaces only what they haven't edited", async () => {
    const { core, sorting, kitchen, race, add } = await start({ automatic: true });
    const [quote] = await add("Kitchen quote");
    if (!quote || !kitchen || !race) throw new Error("Not set up.");

    await vi.waitFor(async () => expect(await proposedFor(core, quote.id)).toBe(kitchen.id));
    expect((await rowOf(core, quote.id)).origin).toBe("background");
    expect((await assignmentOf(core, quote.id))?.groupId).toBeNull();

    await core.classifyDocuments([quote.id]);
    await vi.waitFor(async () => expect((await rowOf(core, quote.id)).origin).toBe("library"));

    const row = await rowOf(core, quote.id);
    await core.editOrganizeReview({
      kind: "move",
      itemIds: [row.id],
      to: { kind: "folder", folderId: race.id },
    });
    const asked = sorting.requests.length;
    await core.classifyDocuments([quote.id]);
    await readAgain(core, sorting, [quote.id], asked);
    expect(await rowOf(core, quote.id)).toMatchObject({
      id: row.id,
      placement: { kind: "folder", folderId: race.id },
      edited: true,
    });
  });

  test("what the User unticked isn't proposed again for 30 days", async () => {
    const clock = manualClock("2026-11-07T09:00:00.000Z");
    const { core, sorting, kitchen, add } = await start({ now: clock.now });
    const [quote] = await add("Kitchen quote");
    if (!quote || !kitchen) throw new Error("Not set up.");
    await core.classifyDocuments([quote.id]);
    await vi.waitFor(async () => expect(await proposedFor(core, quote.id)).toBe(kitchen.id));
    const row = await rowOf(core, quote.id);
    await core.editOrganizeReview({ kind: "tick", itemIds: [row.id], ticked: false });
    await core.discardOrganizeReview([row.id]);

    clock.advance(29 * DAY);
    const asked = sorting.requests.length;
    await core.classifyDocuments([quote.id]);
    await readAgain(core, sorting, [quote.id], asked);
    expect(await proposedFor(core, quote.id)).toBeNull();

    clock.advance(2 * DAY);
    await core.classifyDocuments([quote.id]);
    await vi.waitFor(async () => expect(await proposedFor(core, quote.id)).toBe(kitchen.id));
  });

  test("a scan with no text the User asked to organize waits left out, saying why, and nothing is sent", async () => {
    const { core, sorting } = await start();
    const [scan] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "Scan.pdf", buildPdf([{ image: true }])),
    ]);
    if (!scan) throw new Error("Not added.");
    expect(scan.status).toBe("no-text");

    await core.classifyDocuments([scan.id]);

    await vi.waitFor(async () =>
      expect((await rowOf(core, scan.id)).placement).toEqual({
        kind: "leftOut",
        leftOut: { reason: "noText" },
      }),
    );
    expect(sorting.requests).toEqual([]);
    expect((await core.getLibrary()).reviewCount).toBe(0);
  });

  test("Organize's request carries what it always has: the Folders, proposed ones as Folders, and the Document", async () => {
    const { core, sorting, add } = await start({ folders: false });
    const [quote, plan] = await add("Kitchen quote", "Race plan");
    if (!quote || !plan) throw new Error("Not added.");

    await core.proposeFolders([quote.id, plan.id]);
    await core.classifyDocuments([quote.id, plan.id]);
    await readAgain(core, sorting, [quote.id, plan.id], 0);

    expect(sorting.requests).toHaveLength(2);
    for (const request of sorting.requests) {
      const data = JSON.parse(request) as {
        groups: Record<string, unknown>[];
        document: { name: string };
      };
      expect(Object.keys(data).sort()).toEqual(["document", "groups", "tags"]);
      expect(data.groups.map((each) => Object.keys(each).sort())).toEqual([
        ["description", "id", "name"],
        ["description", "id", "name"],
      ]);
      expect(data.groups.map((each) => each.name)).toEqual(["Kitchen", "Race"]);
      // Nothing of another Document, or of what waits for it, goes with this one.
      const other = data.document.name === "Kitchen quote" ? "Race plan" : "Kitchen quote";
      expect(request).not.toContain(other);
    }
  });
});

describe("Suggestions from before an upgrade (migration 136)", () => {
  test("a Document waiting in a Suggested Folder waits in Suggestions instead, in no Folder, and the Library says so once", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const at = "2026-11-01T09:00:00.000Z";
    // As an earlier version left it: the quote waiting in Kitchen as a suggestion, and the plan
    // filed there by the User.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      migrate(
        db,
        migrations.filter((migration) => migration.version < 136),
      );
      for (const [id, name] of [
        ["kitchen", "Kitchen"],
        ["race", "Race"],
      ] as const) {
        db.run(
          "INSERT INTO library_groups (id, name, description, created_at, updated_at) VALUES (?, ?, '', ?, ?)",
          [id, name, at, at],
        );
      }
      for (const [id, source, suggested] of [
        ["Kitchen quote", "automatic", 1],
        ["Race plan", "user", 0],
      ] as const) {
        const text = `${id}: a few words.`;
        const path = await writeSourceFile(sources, `${id}.txt`, text);
        db.run(
          `INSERT INTO documents (id, content_hash, name, kind, size, status, path, file_status,
             processing_version, metadata_version, created_at, updated_at)
           VALUES (?, ?, ?, 'text', ?, 'ready', ?, 'available', ?, ?, ?, ?)`,
          [
            id,
            sha256(text),
            id,
            Buffer.byteLength(text),
            path,
            BigInt(PROCESSING_VERSION),
            BigInt(METADATA_VERSION),
            at,
            at,
          ],
        );
        db.run(
          `INSERT INTO document_groups
             (id, document_id, group_id, source, suggested, status, content_hash, request_id,
              created_at, updated_at, filed_at)
           VALUES (?, ?, 'kitchen', ?, ?, 'classified', ?, ?, ?, ?, ?)`,
          [`assignment-${id}`, id, source, suggested, sha256(text), `request-${id}`, at, at, at],
        );
      }
    } finally {
      db.close();
    }

    const upgraded = startCore(dataDir);

    expect(await proposedFor(upgraded, "Kitchen quote")).toBe("kitchen");
    expect((await rowOf(upgraded, "Kitchen quote")).origin).toBe("migrated");
    expect(await assignmentOf(upgraded, "Kitchen quote")).toMatchObject({
      groupId: null,
      source: "automatic",
    });
    expect(await assignmentOf(upgraded, "Race plan")).toMatchObject({
      groupId: "kitchen",
      source: "user",
    });
    expect(await proposedFor(upgraded, "Race plan")).toBeNull();
    const library = await upgraded.getLibrary();
    expect(library.groups.map((each) => each.name)).toEqual(["Kitchen", "Race"]);
    expect(library.reviewMoved).toBe(1);
    await upgraded.dismissReviewMoved();
    expect((await upgraded.getLibrary()).reviewMoved).toBeUndefined();
  });

  test("restoring a Folder deleted while a suggestion waited in it puts the suggestion into Suggestions", async () => {
    const { core, dataDir, kitchen, add } = await start();
    const [quote] = await add("Kitchen quote");
    if (!quote || !kitchen) throw new Error("Not set up.");
    await core.assignDocumentGroup(quote.id, kitchen.id);
    await core.deleteLibraryGroup(kitchen.id);
    // Deleted by an earlier version, while the quote waited in it as a suggestion.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE deleted_folder_items SET suggested = 1 WHERE item_id = ?", [quote.id]);
      db.run("UPDATE document_groups SET source = 'automatic' WHERE document_id = ?", [quote.id]);
    } finally {
      db.close();
    }

    await core.restore([{ kind: "folder", id: kitchen.id }]);

    expect(await proposedFor(core, quote.id)).toBe(kitchen.id);
    expect((await rowOf(core, quote.id)).origin).toBe("migrated");
    expect((await assignmentOf(core, quote.id))?.groupId).toBeNull();
  });
});
