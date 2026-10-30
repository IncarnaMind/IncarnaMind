/**
 * The cited page, saved when a Citation is made (#133): how its Location
 * looked in the version it quotes, kept in the data folder while a Citation
 * or a Checkpoint points at it, after its file changes or goes, drawn in the
 * background without slowing an Answer.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  type CapturePage,
  CITED_PAGES_FOLDER,
  DATABASE_FILE,
  type LogFields,
  type PageCaptureRequest,
} from "../../src/core";
import type { CitedUnits } from "../../src/core/answers/citedVersions";
import { createVersionRetention } from "../../src/core/documents/retention";
import { openDatabase } from "../../src/core/storage";
import { calculatedFigureNode, readFigureCitation } from "../../src/shared/calculatedFigures";
import { FORMULA_VERSION } from "../../src/shared/formula";
import {
  answerEnded,
  askAndFinish,
  citationsIn,
  citingModel,
  type ShownPassage,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { PNG, savedPage } from "../helpers/citedPages";
import { queryDatabase, startCore } from "../helpers/core";
import { sha256, waitForDocuments, waitForProcessing } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, note, question, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/formats/${name}`, import.meta.url)));

/** Three pages about tides. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);
const SPRING = "Spring tides happen at new moon and at full moon.";
const TABLES = "Harbours publish the times of high water every year.";
const MOON = "The Moon raises two bulges of water on the Earth.";

/**
 * A viewer drawing off screen, as the desktop app's hidden window does: it
 * keeps what it was asked to draw, and draws a picture of one pixel. Held,
 * it waits until let go, or until the drawing is called off. Told to fail,
 * its next drawings fail as the compositor's do when it gives no picture.
 */
function fakeViewer(steps: string[] = []) {
  const asked: PageCaptureRequest[] = [];
  let held: { promise: Promise<void>; release: () => void } | null = null;
  let failing = 0;
  const capturePage: CapturePage = async (request, signal) => {
    asked.push(request);
    steps.push("drawing");
    if (failing > 0) {
      failing--;
      steps.push("failed");
      throw new Error("UnknownVizError");
    }
    if (held) {
      const { promise } = held;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          steps.push("gave way");
          reject(signal.reason);
        });
        void promise.then(resolve);
      });
    }
    steps.push("drawn");
    return {
      data: PNG,
      type: "image/png",
      width: 1,
      height: 1,
      text: [{ text: request.document.name, box: { x: 0, y: 0, width: 1, height: 1 } }],
    };
  };
  return {
    asked,
    steps,
    capturePage,
    hold() {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { promise, release };
    },
    release() {
      held?.release();
      held = null;
    },
    /** The next `count` drawings fail. */
    fail(count: number) {
      failing = count;
    },
  };
}

/** A log that keeps what it is told, for a test to read. */
function keptLog() {
  const lines: { event: string; fields?: LogFields }[] = [];
  const keep = (event: string, fields?: LogFields) => {
    lines.push({ event, fields });
  };
  return {
    lines,
    log: { info: keep, warn: keep, error: keep },
    of: (prefix: string) => lines.filter((line) => line.event.startsWith(prefix)),
  };
}

/** The pictures in the data folder's cited pages. */
const pictures = (dataDir: string) => {
  const folder = join(dataDir, CITED_PAGES_FOLDER);
  return existsSync(folder) ? readdirSync(folder).sort() : [];
};

/** The cited pages recorded, saved or waiting, and not gone. */
const liveRows = (dataDir: string) =>
  queryDatabase<{ id: string; image_type: string | null; content_hash: string; tries: number }>(
    dataDir,
    "SELECT id, image_type, content_hash, tries FROM cited_pages WHERE deleted_at IS NULL ORDER BY rowid",
  );

// Freeze alpha.4's retained-unit cleanup (e61443ec4), so a current reader cannot mask incompatibility.
function collectRetainedPagesAsAlpha4(dataDir: string): void {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  const retention = createVersionRetention(db, () => new Date().toISOString());
  try {
    const rows = db.all<{
      id: string;
      document_id: string;
      content_hash: string;
      page_from: number;
      page_to: number;
      area: string;
    }>(
      "SELECT id, document_id, content_hash, page_from, page_to, area FROM cited_pages WHERE deleted_at IS NULL",
    );
    const byDocument = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byDocument.get(row.document_id);
      if (list) list.push(row);
      else byDocument.set(row.document_id, [row]);
    }
    const kept = new Set<string>();
    const keep = (
      place: {
        documentId: string;
        contentHash: string | null;
        pageFrom: number;
        pageTo: number;
        area: string | null;
      },
      overlapping: boolean,
    ) => {
      for (const row of byDocument.get(place.documentId) ?? []) {
        if (place.contentHash !== null && row.content_hash !== place.contentHash) continue;
        if (place.area !== null && row.area !== place.area) continue;
        const same = overlapping
          ? row.page_from <= place.pageTo && row.page_to >= place.pageFrom
          : row.page_from === place.pageFrom && row.page_to === place.pageTo;
        if (same) kept.add(row.id);
      }
    };
    const units: CitedUnits[] = [];
    retention.addRetainedUnits(new Set(byDocument.keys()), units, ["checkpoint"]);
    for (const unit of units) {
      const pageFrom = unit.pageFrom ?? 1;
      const pageTo = unit.pageTo ?? Number.MAX_SAFE_INTEGER;
      keep({ ...unit, pageFrom, pageTo, area: null }, true);
    }
    const gone = rows.filter((row) => !kept.has(row.id));
    if (gone.length === 0) return;
    const at = new Date().toISOString();
    db.transaction(() => {
      for (const row of gone) {
        db.run("UPDATE cited_pages SET deleted_at = ?, updated_at = ? WHERE id = ?", [
          at,
          at,
          row.id,
        ]);
        retention.release("saved-page", row.id);
      }
    });
  } finally {
    db.close();
  }
}

const pdfRecord = (passages: ShownPassage[], page: number, quote: string) => ({
  marker: 1,
  passage: passages[0]?.id ?? "none",
  pageFrom: page,
  pageTo: page,
  quote,
});

const byDocument = (passages: ShownPassage[], name: string) =>
  passages.find((passage) => passage.document === name)?.id ?? "none";

describe("The cited page, saved when a Citation is made", { timeout: 60_000 }, () => {
  test("a PDF's cited page is drawn by the page-image worker, with the text on it, and isn't searched", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [pdfRecord(passages, 2, SPRING)],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const { core, client, mind, dataDir } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const [citation] = citationsIn(client, answerId);
    if (!citation) throw new Error("Nothing was cited.");
    const page = await savedPage(core, citation);

    expect(page.type).toBe("image/jpeg");
    expect(Buffer.from(page.data.subarray(0, 3))).toEqual(Buffer.from([255, 216, 255]));
    expect(Math.max(page.width, page.height)).toBe(1600);
    // The quote's line is drawn on it, inside the picture, below the page's heading.
    const line = page.text.find((run) => run.text === SPRING);
    const heading = page.text.find((run) => run.text === "Spring and neap tides");
    expect(line?.box.x).toBeGreaterThan(0);
    expect((line?.box.x ?? 0) + (line?.box.width ?? 0)).toBeLessThan(page.width);
    expect(line?.box.y).toBeGreaterThan(heading?.box.y ?? page.height);
    expect(page.text.some((run) => run.text.includes("Tide tables"))).toBe(false);
    expect(pictures(dataDir)).toEqual([`${liveRows(dataDir)[0]?.id}.jpg`]);
    // Nothing of it is a Document, or searched.
    expect(await core.listDocuments()).toHaveLength(1);
    expect(await core.searchPassages("Spring", { mode: "keyword" })).toHaveLength(1);
  });

  test("a slide, a sheet's rows and a Word section are drawn by their viewer, each Location once", async () => {
    const viewer = fakeViewer();
    const model = citingModel({
      query: "western region revenue barrier crest",
      records: (passages) => [
        {
          marker: 1,
          passage: byDocument(passages, "Deck"),
          location: "slide 3",
          quote: "The western region grew fastest",
        },
        {
          marker: 2,
          passage: byDocument(passages, "Revenue"),
          location: "Revenue, rows 7–8",
          quote: "West 350,200 389,600",
        },
        {
          marker: 3,
          passage: byDocument(passages, "Review"),
          location: "§ 2.1 Sensitivity",
          quote: "Raising the barrier crest by 40 centimetres",
        },
        // The same slide again, another quote: the same picture.
        {
          marker: 4,
          passage: byDocument(passages, "Deck"),
          location: "slide 3",
          quote: "Point at the red bar: that is the west.",
        },
      ],
      answer: "The west grew [^1] and led [^2]; the crest helps [^3], as noted [^4].",
    });
    const { core, client, mind, dataDir } = await setUpWithDocuments(
      model,
      [
        { name: "Deck.pptx", contents: fixture("Quarterly Research Update.pptx") },
        { name: "Revenue.xlsx", contents: fixture("Regional Revenue.xlsx") },
        { name: "Review.docx", contents: fixture("Coastal Flood Risk Review.docx") },
      ],
      { capturePage: viewer.capturePage },
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "Who grew fastest?");
    const citations = citationsIn(client, answerId);
    expect(citations).toHaveLength(4);
    for (const citation of citations) {
      expect((await savedPage(core, citation)).type).toBe("image/png");
    }

    expect(
      viewer.asked.map((request) => ({
        document: request.document.name,
        kind: request.document.kind,
        units: [request.pageFrom, request.pageTo],
        area: request.area,
      })),
    ).toEqual([
      { document: "Deck", kind: "pptx", units: [3, 3], area: { kind: "slide" } },
      {
        document: "Revenue",
        kind: "xlsx",
        units: [1, 1],
        area: { kind: "rows", sheet: "Revenue", from: 7, to: 7 },
      },
      { document: "Review", kind: "docx", units: [5, 5], area: { kind: "section" } },
    ]);
    expect(pictures(dataDir)).toHaveLength(3);

    // Asked again, the same Locations aren't drawn again; other rows of the sheet are.
    const again = citingModel({
      query: "western region revenue",
      records: (passages) => [
        {
          marker: 1,
          passage: byDocument(passages, "Deck"),
          location: "slide 3",
          quote: "The western region grew fastest",
        },
        {
          marker: 2,
          passage: byDocument(passages, "Revenue"),
          location: "Revenue, rows 8",
          quote: "All regions",
        },
      ],
      answer: "Again [^1], and in all [^2].",
    });
    core.close();
    const second = startCore(dataDir, {
      createChatModel: () => again,
      capturePage: viewer.capturePage,
    });
    const secondClient = await connectToMind(second, mind.id);
    const asked = await askAndFinish(second, secondClient, mind.id, "Again?");
    const [slide, rows] = citationsIn(secondClient, asked.answerId);
    if (!slide || !rows) throw new Error("Nothing was cited.");
    await savedPage(second, rows);
    expect(await second.citedPageImage(slide)).not.toBeNull();
    expect(viewer.asked.map((request) => request.area)).toEqual([
      { kind: "slide" },
      { kind: "rows", sheet: "Revenue", from: 7, to: 7 },
      { kind: "section" },
      { kind: "rows", sheet: "Revenue", from: 8, to: 8 },
    ]);
    expect(pictures(dataDir)).toHaveLength(4);
  });

  test("after its file is deleted, and its Document too, the page is still there, across restarts", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [pdfRecord(passages, 2, SPRING)],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const { core, client, mind, dataDir, documents } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const [document] = documents;
    if (!document?.path) throw new Error("Nothing was added.");
    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const [citation] = citationsIn(client, answerId);
    if (!citation) throw new Error("Nothing was cited.");
    const saved = await savedPage(core, citation);
    // The viewer reads it by the Citation's place, through the bridge (#2159).
    const { documentId, contentHash, pageFrom, pageTo, location } = citation;
    if (documentId === null || contentHash === null) throw new Error("The Citation has no place.");
    expect(
      await core.readCitedPage({ documentId, contentHash, pageFrom, pageTo, location }),
    ).toEqual(saved);

    await rm(document.path);
    await core.reconcileDocuments();
    await waitForDocuments(core, (listed) => expect(listed[0]?.fileStatus).toBe("missing"));
    expect(await core.citedPageImage(citation)).toEqual(saved);
    await core.deleteDocument(document.id);
    expect(await core.citedPageImage(citation)).toEqual(saved);
    // The window reads a live Document's page only: the source pack still has the deleted one's.
    await expect(
      core.readCitedPage({ documentId, contentHash, pageFrom, pageTo, location }),
    ).rejects.toThrow();
    core.close();

    const again = startCore(dataDir);
    expect(await again.citedPageImage(citation)).toEqual(saved);
    expect(pictures(dataDir)).toHaveLength(1);
  });

  test("once the last Citation of a page goes, the page goes at the next start, unless a Checkpoint keeps it", async () => {
    const model = citingModel({
      query: "spring tides tables",
      records: (passages) => [
        pdfRecord(passages, 2, SPRING),
        { ...pdfRecord(passages, 3, TABLES), marker: 2 },
      ],
      answer: "Spring tides come at new and full moon [^1]; harbours publish tables [^2].",
    });
    const { core, client, mind, dataDir, documents } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const [spring, tables] = citationsIn(client, answerId);
    if (!spring || !tables) throw new Error("Nothing was cited.");
    await savedPage(core, spring);
    await savedPage(core, tables);
    const retainedBySavedPages = () =>
      queryDatabase(
        dataDir,
        "SELECT 1 FROM retained_versions WHERE kind = 'saved-page' AND deleted_at IS NULL",
      ).length;
    expect(retainedBySavedPages()).toBe(2);

    // A Checkpoint from before the Answer was deleted keeps page 3 (#113).
    const [document] = documents;
    if (!document) throw new Error("Nothing was added.");
    core.retention.retain("checkpoint", "checkpoint-1", [
      { documentId: document.id, contentHash: document.contentHash, pageFrom: 3, pageTo: 3 },
    ]);
    writeMind(client, [note("Nothing is cited here any more.")]);
    await client.settled();
    // Not until the next start: nothing can be undone then.
    expect(await core.citedPageImage(spring)).not.toBeNull();
    core.close();

    const again = startCore(dataDir);
    expect(await again.citedPageImage(spring)).toBeNull();
    expect(await again.citedPageImage(tables)).not.toBeNull();
    expect(pictures(dataDir)).toHaveLength(1);
    expect(retainedBySavedPages()).toBe(1);

    again.retention.release("checkpoint", "checkpoint-1");
    again.close();
    const third = startCore(dataDir);
    expect(await third.citedPageImage(tables)).toBeNull();
    expect(pictures(dataDir)).toEqual([]);
    expect(liveRows(dataDir)).toEqual([]);
    expect(retainedBySavedPages()).toBe(0);
  });

  test("alpha.4's collector keeps a future Note's figure page after the original PDF goes", async () => {
    const quote = "Revenue was 10.";
    const model = citingModel({
      query: "revenue",
      records: (passages) => [pdfRecord(passages, 1, quote)],
      answer: "Revenue was 10 [^1].",
    });
    const { core, client, mind, dataDir, documents } = await setUpWithDocuments(model, [
      { name: "Revenue.pdf", contents: buildPdf([{ lines: ["Revenue", quote] }]) },
    ]);
    const { answerId } = await askAndFinish(core, client, mind.id, "What was revenue?");
    const [citation] = citationsIn(client, answerId);
    const [document] = documents;
    if (!citation?.documentId || !citation.contentHash || !document?.path)
      throw new Error("The page fixture was not cited.");
    const source = readFigureCitation(citation);
    if (!source) throw new Error("The source Citation is incomplete.");
    const saved = await savedPage(core, citation);
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          calculatedFigureNode(
            {
              label: "Revenue",
              formula: "revenue",
              inputs: [
                {
                  name: "revenue",
                  label: "Revenue",
                  citation: source,
                  number: {
                    chars: "10",
                    at: 12,
                    value: 10,
                    scale: 1,
                    scaleWord: null,
                    unit: { kind: "plain" },
                    decimals: 0,
                    approximate: false,
                    reading: null,
                  },
                  cell: null,
                  unitStatement: null,
                },
              ],
              value: 10,
              unit: { kind: "plain" },
              approximate: false,
              shown: "10",
              show: { language: "en", as: "number", decimals: 0, scale: null },
              literals: [],
              engine: FORMULA_VERSION,
              written: null,
            },
            "revenue-figure",
            null,
          ),
        ],
      },
    ]);
    await client.settled();
    const alias = `note-figure:${mind.id}`;
    expect(core.retention.retainedBy("checkpoint", alias)).toHaveLength(1);
    client.doc.getMap("settings").set("schemaVersion", 999);
    await client.settled();
    await rm(document.path);
    core.close();
    collectRetainedPagesAsAlpha4(dataDir);
    expect(liveRows(dataDir)).toHaveLength(1);
    const second = startCore(dataDir);
    expect((await second.openMind(mind.id)).access).toBe("read-only");
    expect(await second.citedPageImage(citation)).toEqual(saved);
    second.retention.release("note-figure", mind.id);
    second.retention.release("checkpoint", alias);
    second.close();
    collectRetainedPagesAsAlpha4(dataDir);
    expect(liveRows(dataDir)).toEqual([]);
    const third = startCore(dataDir);
    expect(await third.citedPageImage(citation)).toBeNull();
    expect(pictures(dataDir)).toEqual([]);
  });

  test("a page is drawn only from the version cited: a file that changes first isn't, its page waits, and an old version's page stays", async () => {
    const viewer = fakeViewer();
    const v1 = `# Tides\n\n${SPRING}\n`;
    const v2 = `# Tides\n\n${SPRING} Neap tides fall between them.\n`;
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id ?? "none", location: "§ Tides", quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const logged = keptLog();
    const { core, client, mind, dataDir, documents } = await setUpWithDocuments(
      model,
      [{ name: "Notes.md", contents: v1 }],
      { capturePage: viewer.capturePage, log: logged.log },
    );
    const [document] = documents;
    if (!document?.path) throw new Error("Nothing was added.");

    // Changed while its page is drawn: not saved, and the log says why, without the file's path.
    viewer.hold();
    const first = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const [changed] = citationsIn(client, first.answerId);
    if (!changed) throw new Error("Nothing was cited.");
    await vi.waitFor(() => expect(viewer.steps).toEqual(["drawing"]));
    await writeFile(document.path, v2);
    viewer.release();
    await vi.waitFor(() => expect(logged.of("citedPage.")).toHaveLength(1));
    expect(logged.of("citedPage.")).toEqual([
      {
        event: "citedPage.notSaved",
        fields: {
          documentId: document.id,
          reason: "The Document changed while its page was drawn.",
          tries: 0,
          lasting: false,
        },
      },
    ]);
    // It waits, not saved, for its file to have that version again: no drawing failed.
    expect(liveRows(dataDir)).toMatchObject([
      { image_type: null, content_hash: sha256(v1), tries: 0 },
    ]);
    expect(await core.citedPageImage(changed)).toBeNull();
    expect(pictures(dataDir)).toEqual([]);

    // The new version is cited and saved; when the file changes again, its page stays.
    await core.reconcileDocuments();
    await waitForDocuments(core, (listed) => expect(listed[0]?.contentHash).toBe(sha256(v2)));
    await waitForProcessing(core, [document.id]);
    const second = await askAndFinish(core, client, mind.id, "When are spring tides again?");
    const [cited] = citationsIn(client, second.answerId);
    if (!cited) throw new Error("Nothing was cited.");
    expect(cited.contentHash).toBe(sha256(v2));
    const saved = await savedPage(core, cited);
    // Each drawing was of the version its Citation quotes.
    expect(viewer.asked.map((request) => request.document.contentHash)).toEqual([
      sha256(v1),
      sha256(v2),
    ]);
    await writeFile(document.path, v1);
    await core.reconcileDocuments();
    await waitForDocuments(core, (listed) => expect(listed[0]?.contentHash).toBe(sha256(v1)));
    core.close();
    const again = startCore(dataDir);
    expect(await again.citedPageImage(cited)).toEqual(saved);
  });

  test("saving doesn't slow an Answer: it waits while one is written, and a drawing under way gives way", async () => {
    const timeline: string[] = [];
    const viewer = fakeViewer(timeline);
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let cites = 0;
    let answers = 0;
    // The first Answer cites the Tides, the second the Moon, held as it streams.
    const model = scriptedModel((call) => {
      if (!call.tools.includes("search_documents")) return { text: "No Tools were offered." };
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "tides moon" } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passages = shownPassages(searches.at(-1)?.text ?? "");
        cites++;
        const record =
          cites === 1
            ? { passage: byDocument(passages, "Tides"), location: "§ Tides", quote: SPRING }
            : { passage: byDocument(passages, "Moon"), location: "§ Moon", quote: MOON };
        return { calls: [{ tool: "cite", input: { citations: [{ marker: 1, ...record }] } }] };
      }
      answers++;
      return {
        text: "Your Documents answer this [^1].",
        pause: answers === 2 ? { after: 8, until: gate } : undefined,
      };
    });
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [
        { name: "Tides.md", contents: `# Tides\n\n${SPRING}\n` },
        { name: "Moon.md", contents: `# Moon\n\n${MOON}\n` },
      ],
      { capturePage: viewer.capturePage },
    );
    const record = (event: string) => (payload: { answerId: string }) => {
      timeline.push(`${event} ${payload.answerId}`);
    };
    core.on("answer.started", record("started"));
    core.on("answer.finished", record("finished"));

    viewer.hold();
    const first = await askAndFinish(core, client, mind.id, "When are spring tides?");
    await vi.waitFor(() => expect(timeline).toContain("drawing"));
    // Asked below the first, which stays.
    const asked = question("What does the Moon do?");
    editMind(client, (blocks) => [...blocks, asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    const second = result.answerId;
    const secondEnded = answerEnded(core, second);
    await vi.waitFor(() => expect(timeline).toContain(`started ${second}`));
    viewer.release();
    // The drawing under way gave way as the second Answer started; nothing is drawn while it is written.
    expect(timeline).toEqual([
      `started ${first.answerId}`,
      `finished ${first.answerId}`,
      "drawing",
      "gave way",
      `started ${second}`,
    ]);
    open();
    expect((await secondEnded).event).toBe("finished");
    for (const answerId of [first.answerId, second]) {
      const [citation] = citationsIn(client, answerId);
      if (!citation) throw new Error("Nothing was cited.");
      await savedPage(core, citation);
    }
    expect(timeline.slice(5)).toEqual([
      `finished ${second}`,
      "drawing",
      "drawn",
      "drawing",
      "drawn",
    ]);
    expect(viewer.asked.map((request) => request.document.name)).toEqual([
      "Tides",
      "Tides",
      "Moon",
    ]);
  });

  test("a page whose picture the compositor didn't give waits, and is saved when it is next asked for", async () => {
    const viewer = fakeViewer();
    const logged = keptLog();
    const model = citingModel({
      query: "barrier crest",
      records: (passages) => [
        {
          marker: 1,
          passage: passages[0]?.id ?? "none",
          location: "§ 2.1 Sensitivity",
          quote: "Raising the barrier crest by 40 centimetres",
        },
      ],
      answer: "The crest helps [^1].",
    });
    viewer.fail(1);
    const { core, client, mind, dataDir, documents } = await setUpWithDocuments(
      model,
      [{ name: "Review.docx", contents: fixture("Coastal Flood Risk Review.docx") }],
      { capturePage: viewer.capturePage, log: logged.log },
    );
    const { answerId } = await askAndFinish(core, client, mind.id, "What does the crest do?");
    const [citation] = citationsIn(client, answerId);
    if (!citation) throw new Error("Nothing was cited.");

    // Not saved, and not given up: it waits, one failure counted, and nothing more is drawn.
    await vi.waitFor(() => expect(viewer.steps).toEqual(["drawing", "failed"]));
    await vi.waitFor(() => expect(liveRows(dataDir)).toMatchObject([{ tries: 1 }]));
    expect(liveRows(dataDir)).toMatchObject([{ image_type: null }]);
    expect(pictures(dataDir)).toEqual([]);

    // Asked for, as a source pack does, it is drawn again and saved, of the version cited.
    expect(await core.citedPageImage(citation)).toBeNull();
    expect((await savedPage(core, citation)).type).toBe("image/png");
    expect(viewer.steps).toEqual(["drawing", "failed", "drawing", "drawn"]);
    expect(viewer.asked.map((request) => request.document.contentHash)).toEqual([
      documents[0]?.contentHash,
      documents[0]?.contentHash,
    ]);
    expect(pictures(dataDir)).toEqual([`${liveRows(dataDir)[0]?.id}.png`]);
    // The log keeps the failed drawing apart from the one that saved it.
    expect(logged.of("citedPage.")).toEqual([
      {
        event: "citedPage.notSaved",
        fields: {
          documentId: documents[0]?.id,
          reason: "UnknownVizError",
          tries: 1,
          lasting: false,
        },
      },
      { event: "citedPage.saved", fields: { documentId: documents[0]?.id, tries: 2 } },
    ]);
  });

  test("a page whose file is moved away before the Library notices waits, counts no failure, and is drawn when the file is back", async () => {
    const viewer = fakeViewer();
    const logged = keptLog();
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id ?? "none", location: "§ Tides", quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    viewer.fail(1);
    const { core, client, mind, dataDir, documents } = await setUpWithDocuments(
      model,
      [{ name: "Notes.md", contents: `# Tides\n\n${SPRING}\n` }],
      { capturePage: viewer.capturePage, log: logged.log },
    );
    const [document] = documents;
    if (!document?.path) throw new Error("Nothing was added.");
    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const [citation] = citationsIn(client, answerId);
    if (!citation) throw new Error("Nothing was cited.");
    await vi.waitFor(() => expect(liveRows(dataDir)).toMatchObject([{ tries: 1 }]));

    // Moved away, then its page asked for, as an export does, before the Library has noticed.
    const moved = `${document.path}.moved`;
    await rename(document.path, moved);
    expect(await core.citedPageImage(citation)).toBeNull();
    await vi.waitFor(() => expect(logged.of("citedPage.notSaved")).toHaveLength(2));
    expect(logged.of("citedPage.notSaved").at(-1)?.fields).toMatchObject({
      reason: "The Document's file isn't there.",
      tries: 1,
      lasting: false,
    });
    expect(viewer.asked).toHaveLength(1);
    expect(liveRows(dataDir)).toMatchObject([{ image_type: null, tries: 1 }]);

    // Back, with the version cited: drawn at the next start, from that version.
    await rename(moved, document.path);
    await core.reconcileDocuments();
    await waitForDocuments(core, (listed) => expect(listed[0]?.fileStatus).toBe("available"));
    core.close();
    const again = startCore(dataDir, { capturePage: viewer.capturePage });
    expect((await savedPage(again, citation)).type).toBe("image/png");
    expect(viewer.asked.map((request) => request.document.contentHash)).toEqual([
      document.contentHash,
      document.contentHash,
    ]);
  });

  test("a page whose drawing keeps failing waits, is tried at each later chance up to three times, then again when cited again", async () => {
    const viewer = fakeViewer();
    const logged = keptLog();
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id ?? "none", location: "§ Tides", quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    viewer.fail(Number.POSITIVE_INFINITY);
    const { core, client, mind, dataDir } = await setUpWithDocuments(
      model,
      [{ name: "Notes.md", contents: `# Tides\n\n${SPRING}\n` }],
      { capturePage: viewer.capturePage, log: logged.log },
    );
    const first = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const [citation] = citationsIn(client, first.answerId);
    if (!citation) throw new Error("Nothing was cited.");
    const tried = (times: number) =>
      vi.waitFor(() => {
        expect(viewer.asked).toHaveLength(times);
        expect(liveRows(dataDir)).toMatchObject([{ image_type: null, tries: times }]);
      });
    await tried(1);
    // Asked for: tried again.
    expect(await core.citedPageImage(citation)).toBeNull();
    await tried(2);
    core.close();

    // The next start tries again: the third failure, which lasts.
    const second = startCore(dataDir, { capturePage: viewer.capturePage, log: logged.log });
    await tried(3);
    expect(logged.of("citedPage.notSaved").map((line) => line.fields?.lasting)).toEqual([
      false,
      false,
      true,
    ]);
    second.close();

    // Not on its own any more: neither the start after nor asking for its page draws it.
    const third = startCore(dataDir, { capturePage: viewer.capturePage, log: logged.log });
    expect(await third.citedPageImage(citation)).toBeNull();
    expect(viewer.asked).toHaveLength(3);
    expect(liveRows(dataDir)).toMatchObject([{ image_type: null, tries: 3 }]);
    third.close();

    // Cited again, it is tried again, and saved once a drawing gives its picture.
    viewer.fail(0);
    const fourth = startCore(dataDir, {
      capturePage: viewer.capturePage,
      createChatModel: () => model,
    });
    const fourthClient = await connectToMind(fourth, mind.id);
    const again = await askAndFinish(fourth, fourthClient, mind.id, "When are spring tides again?");
    const [cited] = citationsIn(fourthClient, again.answerId);
    if (!cited) throw new Error("Nothing was cited.");
    await savedPage(fourth, citation);
    expect(viewer.asked).toHaveLength(4);
    expect(liveRows(dataDir)).toHaveLength(1);
  });

  test("a drawing a quit cut short is made at the next start, and what a quit left half written goes", async () => {
    const viewer = fakeViewer();
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id ?? "none", location: "§ Tides", quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const { core, client, mind, dataDir } = await setUpWithDocuments(
      model,
      [{ name: "Notes.md", contents: `# Tides\n\n${SPRING}\n` }],
      { capturePage: viewer.capturePage },
    );
    viewer.hold();
    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const [citation] = citationsIn(client, answerId);
    if (!citation) throw new Error("Nothing was cited.");
    await vi.waitFor(() => expect(viewer.steps).toEqual(["drawing"]));
    const folder = join(dataDir, CITED_PAGES_FOLDER);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "e1b2.png.7f3a.writing"), "half a picture");
    core.close();
    expect(viewer.steps).toEqual(["drawing", "gave way"]);
    expect(liveRows(dataDir)).toMatchObject([{ image_type: null }]);

    const next = fakeViewer();
    const again = startCore(dataDir, { capturePage: next.capturePage });
    await savedPage(again, citation);
    expect(next.asked).toHaveLength(1);
    expect(pictures(dataDir)).toEqual([`${liveRows(dataDir)[0]?.id}.png`]);
  });
});
