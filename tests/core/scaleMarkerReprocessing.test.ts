/**
 * A page's running header or Word header that states a scale is kept with its Units, and a
 * Document read before a build kept it is read again (#2365). Through the core, as it processes.
 */
import { join } from "node:path";
import { expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { docxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

/** Adds `file` to a core on `dataDir` and closes it; returns the Document's id. */
async function added(dataDir: string, file: { name: string; contents: string | Uint8Array }) {
  const core = startCore(dataDir);
  const [saved] = await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), file.name, file.contents),
  ]);
  if (!saved) throw new Error("Missing Document.");
  core.close();
  return saved.id;
}

const markers = (dataDir: string, id: string) =>
  queryDatabase<{ scale_marker: string }>(
    dataDir,
    "SELECT DISTINCT scale_marker FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
    [id],
  ).map((row) => row.scale_marker);

/** As the build before left a Document: its scale markers never read, and the older pipeline's version. */
function asBefore(dataDir: string, id: string, version: number) {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  db.run("UPDATE document_pages SET scale_marker = '' WHERE document_id = ?", [id]);
  db.run("UPDATE documents SET processing_version = ? WHERE id = ?", [version, id]);
  db.close();
}

test("a PDF read before this build is read again and keeps a running header's “(000 omitted)”", {
  timeout: 60_000,
}, async () => {
  const dataDir = await createTempDataFolder();
  const pages = [
    "Revenue 1,234.5",
    "Notes continue here.",
    "More notes here.",
    "The notes end.",
  ].map((line) => ({ lines: ["Holdings Ltd (000 omitted)", line] }));
  const id = await added(dataDir, { name: "Holdings accounts.pdf", contents: buildPdf(pages) });
  asBefore(dataDir, id, 19);

  const again = startCore(dataDir);
  expect((await again.listDocuments())[0]).toMatchObject({ id, status: "queued" });
  await waitForProcessing(again, [id]);
  expect(markers(dataDir, id)).toEqual(["(000 omitted)"]);
  again.close();
});

test("a Word file read before this build is read again in the background, keeps its Passages, and gains its header's scale", {
  timeout: 60_000,
}, async () => {
  const dataDir = await createTempDataFolder();
  const id = await added(dataDir, {
    name: "Alpha accounts.docx",
    contents: docxOf(
      [
        { text: "Alpha Holdings accounts", heading: 1 },
        { text: "Revenue 1,234.5" },
        { text: "Costs 334.5" },
      ],
      { header: "Amounts in £'000" },
    ),
  });
  const passages = () =>
    queryDatabase<{ id: string; text: string }>(
      dataDir,
      "SELECT id, text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY seq",
      [id],
    );
  const before = passages();
  asBefore(dataDir, id, 20);

  const again = startCore(dataDir);
  // The start doesn't wait for it: the Word file is only queued.
  expect((await again.listDocuments())[0]).toMatchObject({ id, status: "queued" });
  await waitForProcessing(again, [id]);
  expect(markers(dataDir, id)).toEqual(["£'000"]);
  expect(passages()).toEqual(before);
  again.close();
});
