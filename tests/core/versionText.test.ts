/**
 * The text kept of one version, and when that version was made (#2159): what
 * the viewer reads to show a Citation's version after its Document changed,
 * marked "As cited, {date}".
 */
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { askAndFinish, citingModel, onlyCitation } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, sha256, waitForProcessing } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { scriptedModels } from "../helpers/models";

const OLD = "For the Supplier, the notice period is sixty (60) days.";
const NEW = "For the Supplier, the notice period is forty-five (45) days.";
const QUESTION = "What notice period does the Supplier give?";
const OTHER = "Either party may end it in writing.";

const V1 = ["# Notice", "", OLD, "", "# Termination", "", OTHER, ""].join("\n");
const V2 = ["# Notice", "", NEW, "", "# Termination", "", OTHER, ""].join("\n");

/** When each version was made: the files' own dates, weeks apart. */
const MADE_A = new Date("2026-09-14T09:30:00Z");
const MADE_B = new Date("2026-10-21T12:00:00Z");

interface Cited {
  core: Core;
  document: Document;
  pageFrom: number | null;
  pageTo: number | null;
}

/** A core whose Mind cites version A of a Markdown file, which the file then leaves for version B. */
async function cited(): Promise<Cited> {
  const model = citingModel({
    query: "notice period",
    records: (passages) => [
      {
        marker: 1,
        passage: passages.find((each) => each.text.includes(OLD.slice(0, 12)))?.id,
        quote: OLD,
      },
    ],
    answer: "The Supplier gives sixty days' notice [^1].",
  });
  const models = scriptedModels(model);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: models.createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const path = join(await createSourceFolder(), "Amendment.md");
  await writeFile(path, V1);
  await utimes(path, MADE_A, MADE_A);
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("Nothing was added.");
  const mind = await core.createMind({ title: "Notice" });
  const client = await connectToMind(core, mind.id);
  const { answerId } = await askAndFinish(core, client, mind.id, QUESTION);
  const citation = onlyCitation(client, answerId);
  expect(citation.contentHash).toBe(sha256(V1));

  // The file changes after the Citation was made: version B is current, and version A stays for it.
  await writeFile(path, V2);
  await utimes(path, MADE_B, MADE_B);
  await core.reconcileDocuments();
  const [current] = await waitForProcessing(core, [document.id]);
  expect(current?.contentHash).toBe(sha256(V2));

  return {
    core,
    document,
    pageFrom: citation.pageFrom,
    pageTo: citation.pageTo,
  };
}

describe("The text kept of a Document's version", { timeout: 30_000 }, () => {
  test("a Citation's version is read back with its Units and when it was made, and no other", async () => {
    const { core, document, pageFrom, pageTo } = await cited();
    const citedVersion = await core.readVersionText({
      documentId: document.id,
      contentHash: sha256(V1),
      pageFrom,
      pageTo,
    });
    expect(citedVersion).toMatchObject({
      documentId: document.id,
      contentHash: sha256(V1),
      versionAt: MADE_A.toISOString(),
    });
    // The cited section as it was: its kind, its heading and the words the Citation quotes.
    expect(citedVersion?.pages).toHaveLength(1);
    expect(citedVersion?.pages[0]).toMatchObject({ page: 1, kind: "section" });
    expect(citedVersion?.pages[0]?.label?.path).toEqual(["Notice"]);
    expect(citedVersion?.pages[0]?.text).toContain(OLD);
    expect(citedVersion?.pages[0]?.text).not.toContain(NEW);
    // The current version is version B's, as `readDocumentText` reads it.
    const current = await core.readDocumentText(document.id);
    expect(current.contentHash).toBe(sha256(V2));
    expect(current.pages.map((page) => page.text).join("\n")).toContain(NEW);

    // Units the version doesn't have, and text it never kept: nothing to show.
    expect(
      await core.readVersionText({
        documentId: document.id,
        contentHash: sha256(V1),
        pageFrom: 9,
        pageTo: 9,
      }),
    ).toBeNull();
    expect(
      await core.readVersionText({
        documentId: document.id,
        contentHash: sha256("a version never indexed"),
        pageFrom: null,
        pageTo: null,
      }),
    ).toBeNull();
    await expect(
      core.readVersionText({
        documentId: "gone",
        contentHash: sha256(V1),
        pageFrom: null,
        pageTo: null,
      }),
    ).rejects.toThrow();
    await expect(
      core.readVersionText({
        documentId: document.id,
        contentHash: "",
        pageFrom: null,
        pageTo: null,
      }),
    ).rejects.toThrow();
  });

  test("a file dated 0 is read as kept when its text was, not as made in 1970", async () => {
    const core = startCore(await createTempDataFolder());
    const path = join(await createSourceFolder(), "Undated.md");
    await writeFile(path, V1);
    await utimes(path, 0, 0);
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("Nothing was added.");
    const version = await core.readVersionText({
      documentId: document.id,
      contentHash: document.contentHash,
      pageFrom: null,
      pageTo: null,
    });
    expect(version?.versionAt).not.toBe(new Date(0).toISOString());
    expect(Date.parse(version?.versionAt ?? "")).toBeGreaterThan(Date.UTC(2024, 0, 1));
    core.close();
  });

  test("every Unit kept is read when the Citation says no Units", async () => {
    const { core, document } = await cited();
    const version = await core.readVersionText({
      documentId: document.id,
      contentHash: sha256(V1),
      pageFrom: null,
      pageTo: null,
    });
    expect(version?.pages.map((page) => page.label?.path)).toEqual([["Notice"], ["Termination"]]);
  });

  test("text kept before versions had a date of their own dates a current version from its file", async () => {
    const at = "2026-10-01T08:00:00.000Z";
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    try {
      migrate(
        db,
        migrations.filter((each) => each.version <= 115),
      );
      db.run(
        `INSERT INTO documents (id, content_hash, name, kind, size, status, file_mtime_ms, created_at, updated_at)
         VALUES ('d1', 'current', 'Deed.md', 'markdown', 12, 'ready', ?, ?, ?)`,
        [MADE_A.getTime(), at, at],
      );
      // Two versions of its text: the current one, and one it left before this migration.
      for (const [id, hash] of [
        ["p1", "current"],
        ["p2", "older"],
      ] as const) {
        db.run(
          `INSERT INTO document_pages (id, document_id, content_hash, page, text, created_at, updated_at)
           VALUES (?, 'd1', ?, 1, 'Words of the deed', ?, ?)`,
          [id, hash, at, at],
        );
      }
      // A file the file system dates 0 has no date the app can use.
      db.run(
        `INSERT INTO documents (id, content_hash, name, kind, size, status, file_mtime_ms, created_at, updated_at)
         VALUES ('d2', 'zeroed', 'Undated.md', 'markdown', 12, 'ready', 0, ?, ?)`,
        [at, at],
      );
      db.run(
        `INSERT INTO document_pages (id, document_id, content_hash, page, text, created_at, updated_at)
         VALUES ('p3', 'd2', 'zeroed', 1, 'Words with no date', ?, ?)`,
        [at, at],
      );
      migrate(db);
      // The current version's date is its file's modified time, already kept for it.
      expect(db.get("SELECT version_at FROM document_pages WHERE id = 'p1'")).toEqual({
        version_at: MADE_A.toISOString(),
      });
      // A version the file has left knows none of its own: as close as the app can say is when it kept it.
      expect(db.get("SELECT version_at FROM document_pages WHERE id = 'p2'")).toEqual({
        version_at: null,
      });
      expect(
        db.get(
          "SELECT COALESCE(version_at, created_at) AS version_at FROM document_pages WHERE id = 'p2'",
        ),
      ).toEqual({ version_at: at });
      expect(db.get("SELECT version_at FROM document_pages WHERE id = 'p3'")).toEqual({
        version_at: null,
      });
    } finally {
      db.close();
    }
  });
});
