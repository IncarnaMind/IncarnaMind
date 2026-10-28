import { expect, test } from "vitest";
import { citationSentences } from "../../src/core/answers/checks/sentences";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { FORMULA_VERSION } from "../../src/shared/formula";
import {
  addSignOff,
  citationSignOffBasis,
  figureSignOffBasis,
  signOffsOf,
} from "../../src/shared/signOffs";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";

/*
 * The User's own "Checked by me" through the core (#1933): a figure's mark rests on what it was
 * checked against, the version kept as the Note was sent is the one the file holds, and a
 * restore never changes the marks. Cases from Codex2's review of #2144, in English and Chinese.
 */

for (const language of ["en", "zh-CN"] as const) {
  // protects=a calculated figure's mark shows as changed once the words of its sentence change, though its own result is the same; fails_when=it still reads checked; no_claim=its inputs' versions, which signOffs.test covers.
  test(`a calculated figure's mark changes with the sentence ${language}`, async () => {
    const core = startCore(await createTempDataFolder());
    await core.updateSettings({ user: { language, personId: "person-1" } });
    const mind = await core.createMind({ title: "Review fixture" });
    const client = await connectToMind(core, mind.id);
    const figure = calculatedFigureNode(
      {
        label: "value",
        formula: "x",
        inputs: [
          {
            name: "x",
            label: "value",
            citation: {
              passageId: "passage-1",
              documentId: "document-1",
              documentName: "Values",
              contentHash: "v1",
              pageFrom: 1,
              pageTo: 1,
              location: { kind: "page", from: 1, to: 1 },
              quote: "10",
              check: "found",
              checkReason: null,
            },
            number: {
              chars: "10",
              at: 0,
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
        show: { language, as: "number", decimals: 0, scale: null },
        literals: [],
        engine: FORMULA_VERSION,
        written: null,
      },
      "atom-1",
      null,
    );
    const write = (text: string) =>
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [{ type: "text", text }, figure, { type: "text", text: "." }],
        },
      ]);
    write(language === "en" ? "Revenue was " : "营业收入为 ");
    await client.settled();
    const row = (await core.getFigureSchedule(mind.id)).rows.find((r) => r.id === "atom-1");
    if (!row) throw new Error("Missing calculated figure");
    addSignOff(client.doc, {
      id: "mark-1",
      target: { kind: "figure", id: row.id },
      at: "2026-10-28T09:00:00.000Z",
      contentHash: figureSignOffBasis(row),
      deletedAt: null,
      name: "Ada",
      personId: "person-1",
    });
    await client.settled();
    expect(
      (await core.getFigureSchedule(mind.id)).rows.find((r) => r.id === "atom-1")?.signOff?.state,
    ).toBe("checked");
    write(language === "en" ? "Costs were " : "支出为 ");
    await client.settled();
    const changed = (await core.getFigureSchedule(mind.id)).rows.find((r) => r.id === "atom-1");
    expect(changed?.signOff?.state).toBe("changed");
  });

  // protects=a table cell's mark shows as changed once its row's label changes, as the row is what it was checked against; fails_when=it still reads checked; no_claim=another table's cells.
  test(`a table cell's mark changes with its row label ${language}`, async () => {
    const core = startCore(await createTempDataFolder());
    await core.updateSettings({ user: { language, personId: "person-1" } });
    const mind = await core.createMind({ title: "Table" });
    const client = await connectToMind(core, mind.id);
    const cell = (id: string, text: string, header = false) => ({
      type: header ? "tableHeader" : "tableCell",
      content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }],
    });
    const write = (label: string) =>
      writeMind(client, [
        {
          type: "table",
          attrs: { id: "t1" },
          content: [
            {
              type: "tableRow",
              content: [cell("corner", "Item", true), cell("column", "Amount", true)],
            },
            { type: "tableRow", content: [cell("label", label), cell("value", "100")] },
          ],
        },
      ]);
    write(language === "en" ? "Revenue" : "营业收入");
    await client.settled();
    const row = (await core.getFigureSchedule(mind.id)).rows.find((r) => r.reading.chars === "100");
    if (!row) throw new Error("Missing table value");
    addSignOff(client.doc, {
      id: "mark-1",
      target: { kind: "figure", id: row.id },
      at: "2026-10-28T09:00:00.000Z",
      contentHash: figureSignOffBasis(row),
      deletedAt: null,
      name: "Ada",
      personId: "person-1",
    });
    await client.settled();
    expect(
      (await core.getFigureSchedule(mind.id)).rows.find((r) => r.reading.chars === "100")?.signOff
        ?.state,
    ).toBe("checked");
    write(language === "en" ? "Costs" : "支出");
    await client.settled();
    const changed = (await core.getFigureSchedule(mind.id)).rows.find(
      (r) => r.reading.chars === "100",
    );
    expect(changed?.signOff?.state).toBe("changed");
  });

  // protects=the version History keeps as the Note was sent is the text the file holds, even when the User writes while the PDF is made; fails_when=it holds the later text; no_claim=the PDF's look.
  test(`the sent PDF version is the content printed, even after an edit ${language}`, async () => {
    let entered: (() => void) | undefined;
    const printing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let printed = "";
    const core = startCore(await createTempDataFolder(), {
      printer: {
        print: async (document) => {
          printed = document.body;
          entered?.();
          await released;
          return new TextEncoder().encode("%PDF-review-fixture");
        },
      },
    });
    await core.updateSettings({ user: { language } });
    await core.setOutputLocation(await createTempDataFolder());
    const mind = await core.createMind({ title: "Sent content" });
    const client = await connectToMind(core, mind.id);
    const original = language === "en" ? "Approved revenue is ten." : "已批准收入为十。";
    const later = language === "en" ? "Unreviewed costs are twenty." : "尚未核对支出为二十。";
    writeMind(client, [note(original)]);
    await client.settled();
    const sending = core.saveMindExport(mind.id, { format: "pdf" });
    try {
      await printing;
      expect(printed).toContain(original);
      expect(printed).not.toContain(later);
      writeMind(client, [note(later)]);
      await client.settled();
    } finally {
      release?.();
    }
    expect((await sending).status).toBe("saved");
    const sent = (await core.listCheckpoints(mind.id)).checkpoints.find(
      (c) => c.reason === "export",
    );
    if (!sent) throw new Error("No sent checkpoint");
    await core.restoreCheckpoint(mind.id, sent.id);
    await client.settled();
    expect(readMind(client).textContent).toContain(original);
    expect(readMind(client).textContent).not.toContain(later);
  });

  // protects=restoring a version from before a Citation was marked never changes the mark: the same Citation in the same place regains the id the mark names; fails_when=the mark is left on nothing; no_claim=a Citation the restore doesn't bring back.
  test(`restoring the same Citation from before marking keeps its mark ${language}`, async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Restore evidence" });
    const client = await connectToMind(core, mind.id);
    const words = language === "en" ? "The sea rises" : "海平面上升";
    const attributes = {
      passageId: "passage-1",
      documentId: "document-1",
      documentName: "Tides",
      contentHash: "v1",
      pageFrom: 1,
      pageTo: 1,
      quote: "Tides rise.",
      check: "found",
    };
    const write = (marked: boolean) =>
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [
            { type: "text", text: words },
            { type: "citation", attrs: { ...attributes, ...(marked ? { id: "c1" } : {}) } },
            { type: "text", text: "." },
          ],
        },
      ]);
    write(false);
    await client.settled();
    const beforeMark = await core.saveCheckpoint(mind.id, "accept");
    write(true);
    addSignOff(client.doc, {
      id: "mark-1",
      target: { kind: "citation", id: "c1" },
      at: "2026-10-28T09:00:00.000Z",
      contentHash: citationSignOffBasis(words + "\uFFFC.", attributes),
      deletedAt: null,
      name: "Ada",
      personId: "person-1",
    });
    await client.settled();
    expect(citationSentences(client.blocks).has("c1")).toBe(true);
    await core.restoreCheckpoint(mind.id, beforeMark.id);
    await client.settled();
    const held = signOffsOf(client.doc);
    const identities = citationSentences(client.blocks);
    expect(held).toHaveLength(1);
    expect(identities.has(held[0]?.target.id ?? "")).toBe(true);
  });
}
