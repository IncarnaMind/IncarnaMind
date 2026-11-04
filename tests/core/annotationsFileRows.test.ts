/**
 * A PDF's own highlights and notes are read once per version (#327): a re-read
 * of the same file keeps the User's edits and deletes instead of bringing the
 * file's words back.
 */
import { join } from "node:path";
import { expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { type AnnotationCiter, createAnnotations } from "../../src/core/annotations";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";

test("a re-read of the same version keeps the User's edit and delete", async () => {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const sources = await createSourceFolder();
  const path = await writeSourceFile(
    sources,
    "Rate cuts.pdf",
    buildPdf(
      [
        {
          lines: ["Grocers studied across the eleven chains."],
          marks: [
            {
              subtype: "Highlight",
              rect: [72, 748, 300, 764],
              quadPoints: [72, 764, 300, 764, 72, 748, 300, 748],
              contents: "Compare with Table 3.",
              title: "Priya Raman",
              color: [1, 0.9, 0.2],
            },
            {
              subtype: "Text",
              rect: [320, 700, 340, 720],
              contents: "Check this figure.",
              title: "Priya Raman",
              color: [1, 1, 0],
            },
          ],
        },
      ],
      {},
    ),
  );
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("The Document wasn't added.");
  core.close();

  const db = openDatabase(join(dataDir, DATABASE_FILE));
  const citer: AnnotationCiter = {
    currentVersion: () => null,
    cite: (_documentId, anchor) => {
      const unit = anchor.unit ?? 1;
      return {
        quote: anchor.parts[0]?.text ?? "",
        check: "found",
        checkReason: null,
        contentHash: document.contentHash,
        passageId: null,
        pageFrom: unit,
        pageTo: unit,
        location: { kind: "page", from: unit, to: unit },
      };
    },
  };
  const store = createAnnotations(db, () => new Date().toISOString(), citer);
  const rows = store.list(document.id);
  const highlight = rows.find((row) => row.quote !== "");
  const sticky = rows.find((row) => row.quote === "");
  if (!highlight || !sticky) throw new Error("The file's annotations weren't read.");
  const fileRows = rows.map((row) => ({
    page: row.pageFrom ?? 1,
    kind: row.quote === "" ? ("note" as const) : ("highlight" as const),
    quote: row.quote,
    note: row.note,
    colour: row.colour,
    author: row.author,
  }));

  store.update(highlight.id, { note: "Mine", colour: "pink" });
  store.remove(sticky.id);
  store.replaceFileAnnotations(document.id, document.contentHash ?? "", fileRows);

  const reread = store.list(document.id);
  expect(
    reread.map((row) => ({ id: row.id, note: row.note, colour: row.colour })),
    "the same highlight, with the User's note and colour, and the note they deleted still gone",
  ).toEqual([{ id: highlight.id, note: "Mine", colour: "pink" }]);
  db.close();
});
