import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CHECKPOINT_IDLE_MS,
  type ComparisonRow,
  type Core,
  InvalidInputError,
  MindReadOnlyError,
  NotFoundError,
} from "../../src/core";
import { idleToThin } from "../../src/core/checkpoints/thinning";
import { citationState } from "../../src/shared/citations";
import { answerEnded, askAndFinish, citingModel, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { sha256, waitForProcessing } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { answerIn, heading, note, readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

/*
 * History (#113): a Checkpoint of a Mind before every AI change and after a
 * pause, thinned as idle ones age, compared with another or with now, and
 * restored as a new change that keeps the Citations it brings back checkable.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The Mind's paragraphs and headings, one line each. */
const lines = (client: MindClient) => {
  const found: string[] = [];
  readMind(client).descendants((node) => {
    if (!node.isTextblock) return true;
    found.push(node.textContent);
    return false;
  });
  return found;
};

/** A side of a row as text: removed words as [-…-], added as {+…+}, a Citation as ⟨n⟩. */
const shown = (side: ComparisonRow["left"]) =>
  side === null
    ? null
    : side.parts
        .map((part) => {
          const text = part.kind === "citation" ? "⟨c⟩" : part.text;
          return part.change === "removed"
            ? `[-${text}-]`
            : part.change === "added"
              ? `{+${text}+}`
              : text;
        })
        .join("");

async function mindWith(core: Core, texts: string[]) {
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  writeMind(
    client,
    texts.map((text) => note(text)),
  );
  await client.settled();
  return { mind, client };
}

/** Deletes `count` characters of the paragraph at `index`, `offset` in: nothing is added. */
async function deleteText(client: MindClient, index: number, offset: number, count: number) {
  const paragraph = client.blocks.get(index);
  const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
  if (!(text instanceof Y.XmlText)) throw new Error(`Block ${index} isn't a paragraph.`);
  text.delete(offset, count);
  await client.settled();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Thinning idle Checkpoints", () => {
  const now = new Date("2026-10-06T09:00:00.000Z");
  const at = (age: number, id: string) => ({
    id,
    createdAt: new Date(now.getTime() - age).toISOString(),
  });

  test("every one younger than a day stays, however many", () => {
    const idle = [at(0, "a"), at(10 * 60_000, "b"), at(20 * 60_000, "c"), at(DAY - 1, "d")];
    expect(idleToThin(idle, now)).toEqual([]);
  });

  test("from a day old, one an hour: the newest in each hour, whatever is younger than a day", () => {
    const idle = [
      at(DAY - 1, "under a day"),
      at(DAY, "a day, 09:00"),
      at(DAY + 10 * 60_000, "08:50"),
      at(DAY + 50 * 60_000, "08:10"),
      at(7 * DAY - 1, "last hourly"),
    ];
    expect(idleToThin(idle, now)).toEqual(["08:10"]);
  });

  test("from a week old, one a day; from 90 days old, one a week", () => {
    const idle = [
      at(7 * DAY - HOUR, "hourly, 10:00"),
      at(7 * DAY, "a week, 09:00"),
      at(7 * DAY + HOUR, "same day, 08:00"),
      at(90 * DAY - HOUR, "daily, 10:00"),
      at(90 * DAY, "90 days, 09:00"),
      at(90 * DAY + HOUR, "same week, 08:00"),
      at(90 * DAY + 2 * HOUR, "same week, 07:00"),
    ];
    expect(idleToThin(idle, now)).toEqual([
      "same day, 08:00",
      "same week, 08:00",
      "same week, 07:00",
    ]);
  });

  test("a stretch keeps its newest, in whatever order they come", () => {
    const idle = [at(DAY + 50 * 60_000, "older"), at(DAY + 10 * 60_000, "newer")];
    expect(idleToThin(idle, now)).toEqual(["older"]);
  });

  test("through the core: idle ones thin as the clock moves on, ones before an AI change stay", async () => {
    const dataDir = await createTempDataFolder();
    const clock = manualClock("2026-10-06T08:05:00.000Z");
    const core = startCore(dataDir, { now: clock.now });
    const { mind, client } = await mindWith(core, ["Spring tides"]);
    const saved: Record<string, string> = {};
    for (const [name, minutes] of [
      ["idle 08:05", 0],
      ["idle 08:25", 20],
      ["idle 08:45", 20],
    ] as const) {
      clock.advance(minutes * 60_000);
      writeMind(client, [note(`Spring tides, ${name}`)]);
      await client.settled();
      saved[name] = (await core.saveCheckpoint(mind.id, "idle")).id;
      if (name === "idle 08:25") {
        writeMind(client, [note("Spring tides, before an AI change")]);
        await client.settled();
        saved.ai = (await core.saveCheckpoint(mind.id, "accept")).id;
      }
    }
    expect((await core.listCheckpoints(mind.id)).checkpoints).toHaveLength(4);

    // A day later, the next idle one thins that hour to its newest.
    clock.advance(DAY);
    writeMind(client, [note("Spring tides, the next day")]);
    await client.settled();
    const next = await core.saveCheckpoint(mind.id, "idle");
    const { checkpoints } = await core.listCheckpoints(mind.id);
    expect(checkpoints.map((each) => each.id)).toEqual([next.id, saved["idle 08:45"], saved.ai]);
    expect(checkpoints.map((each) => each.reason)).toEqual(["idle", "idle", "accept"]);
    // Thinned rows are kept for a later sync, emptied.
    const rows = queryDatabase<{ id: string; data: Uint8Array; deleted_at: string | null }>(
      dataDir,
      "SELECT id, data, deleted_at FROM mind_checkpoints WHERE deleted_at IS NOT NULL",
    );
    expect(rows.map((row) => row.id).sort()).toEqual(
      [saved["idle 08:05"], saved["idle 08:25"]].sort(),
    );
    expect(rows.every((row) => row.data.byteLength === 0)).toBe(true);
  });
});

describe("Saving a Checkpoint", () => {
  test("an unchanged Mind isn't saved again; a deletion alone is; an idle one becomes one before an AI change", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const { mind, client } = await mindWith(core, ["Spring tides happen at new and full moon."]);
    const changed: string[] = [];
    core.on("checkpoints.changed", ({ mindId }) => changed.push(mindId));

    const first = await core.saveCheckpoint(mind.id, "idle");
    expect(first).toMatchObject({ mindId: mind.id, reason: "idle" });
    // Nothing changed: the same one, nothing new.
    expect(await core.saveCheckpoint(mind.id, "idle")).toEqual(first);
    expect((await core.listCheckpoints(mind.id)).checkpoints).toEqual([first]);
    expect((await core.listCheckpoints(mind.id)).current).toBe(first.id);

    // Before an AI change, an idle one of the same state is kept for good.
    const accepted = await core.saveCheckpoint(mind.id, "accept");
    expect(accepted).toEqual({ ...first, reason: "accept" });
    expect((await core.listCheckpoints(mind.id)).checkpoints).toEqual([accepted]);
    expect(await core.saveCheckpoint(mind.id, "idle")).toEqual(accepted);

    // Words only deleted: the state vector is the same, the snapshot isn't.
    const before = Y.encodeStateVector(client.doc);
    await deleteText(client, 0, 0, "Spring ".length);
    expect(Y.encodeStateVector(client.doc)).toEqual(before);
    expect((await core.listCheckpoints(mind.id)).current).toBeNull();
    const second = await core.saveCheckpoint(mind.id, "idle");
    expect(second.id).not.toBe(first.id);
    expect((await core.listCheckpoints(mind.id)).checkpoints.map((each) => each.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(changed).toEqual([mind.id, mind.id, mind.id]);
  });

  test("takes only a Mind that exists and a reason it knows", async () => {
    const core = startCore(await createTempDataFolder());
    const { mind } = await mindWith(core, ["Tides"]);
    await expect(core.saveCheckpoint(mind.id, "whim" as never)).rejects.toThrow(InvalidInputError);
    await expect(core.saveCheckpoint("gone", "accept")).rejects.toThrow(NotFoundError);
    await core.deleteMind(mind.id);
    await expect(core.saveCheckpoint(mind.id, "accept")).rejects.toThrow(NotFoundError);
  });

  test("a Regenerate that can't start saves none: an Answer that isn't there, or no model ready", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "question",
        attrs: { id: "question-1" },
        content: [{ type: "text", text: "When are spring tides?" }],
      },
      {
        type: "answer",
        attrs: { id: "answer-1", questionId: "question-1", status: "done" },
        content: [
          { type: "paragraph", content: [{ type: "text", text: "At new and full moon." }] },
        ],
      },
    ]);
    await client.settled();
    await expect(core.regenerateAnswer({ mindId: mind.id, answerId: "nothing" })).rejects.toThrow(
      NotFoundError,
    );
    const result = await core.regenerateAnswer({ mindId: mind.id, answerId: "answer-1" });
    expect(result.asked).toBe(false);
    expect((await core.listCheckpoints(mind.id)).checkpoints).toEqual([]);
  });

  test("after five minutes without a change, an idle one is saved; quitting before then saves none", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const { mind, client } = await mindWith(core, ["Neap tides"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    writeMind(client, [note("Neap tides come at the quarter moons.")]);
    await client.settled();
    vi.advanceTimersByTime(CHECKPOINT_IDLE_MS - 1);
    expect((await core.listCheckpoints(mind.id)).checkpoints).toEqual([]);
    // Another change starts the wait again.
    writeMind(client, [note("Neap tides come at the first and last quarter.")]);
    await client.settled();
    vi.advanceTimersByTime(CHECKPOINT_IDLE_MS - 1);
    expect((await core.listCheckpoints(mind.id)).checkpoints).toEqual([]);
    vi.advanceTimersByTime(1);
    const { checkpoints, current } = await core.listCheckpoints(mind.id);
    expect(checkpoints.map((each) => each.reason)).toEqual(["idle"]);
    expect(current).toBe(checkpoints[0]?.id);

    writeMind(client, [note("Neap tides are the smallest.")]);
    await client.settled();
    core.close();
    vi.useRealTimers();
    const again = startCore(dataDir);
    const after = await again.listCheckpoints(mind.id);
    expect(after.checkpoints).toEqual(checkpoints);
    expect(after.current).toBeNull();
  });
});

describe("Comparing and restoring", () => {
  test("two stored Checkpoints are compared Block by Block and word by word", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Sleep" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      heading(2, "Consolidation during sleep"),
      note("Replay during slow-wave sleep slowly moves it over into the neocortex."),
      note("Maybe a nap study is enough for my pilot?"),
      note("Find out how the Leeds lab scores sleep stages."),
    ]);
    await client.settled();
    const earlier = await core.saveCheckpoint(mind.id, "accept");
    writeMind(client, [
      heading(2, "Consolidation during sleep"),
      note("Replay during slow-wave sleep moves it to the neocortex."),
      note("Ask Dr Okafor whether a nap design is enough."),
      note("Find out how the Leeds lab scores sleep stages."),
      note("Rasch and Born call this active systems consolidation."),
    ]);
    await client.settled();
    const later = await core.saveCheckpoint(mind.id, "idle");

    const compared = await core.compareCheckpoints({
      mindId: mind.id,
      from: earlier.id,
      to: later.id,
    });
    expect(compared.changes).toBe(3);
    expect(compared.rows.map((row) => [shown(row.left), shown(row.right), row.changed])).toEqual([
      ["Consolidation during sleep", "Consolidation during sleep", false],
      [
        "Replay during slow-wave sleep [-slowly -]moves it [-over into-] the neocortex.",
        "Replay during slow-wave sleep moves it {+to+} the neocortex.",
        true,
      ],
      [
        "[-Maybe -]a nap [-study-] is enough[- for my pilot?-]",
        "{+Ask Dr Okafor whether +}a nap {+design+} is enough{+.+}",
        true,
      ],
      [
        "Find out how the Leeds lab scores sleep stages.",
        "Find out how the Leeds lab scores sleep stages.",
        false,
      ],
      [null, "{+Rasch and Born call this active systems consolidation.+}", true],
    ]);
    expect(compared.rows[0]?.left).toMatchObject({ kind: "heading", level: 2 });

    // With now, which is the later one: no changes at all.
    const now = await core.compareCheckpoints({ mindId: mind.id, from: later.id, to: null });
    expect(now.changes).toBe(0);
    // Two that read the same, in either order.
    const back = await core.compareCheckpoints({ mindId: mind.id, from: later.id, to: earlier.id });
    expect(back.rows[1]?.left?.parts.some((part) => part.change === "removed")).toBe(true);
    await expect(
      core.compareCheckpoints({ mindId: mind.id, from: "nothing", to: null }),
    ).rejects.toThrow(NotFoundError);
  });

  test("a list item renumbered by one added above is unchanged; Citations and tables compare too", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    const text = (value: string) => ({ type: "text", text: value });
    const item = (value: string) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [text(value)] }],
    });
    const cited = {
      type: "citation",
      attrs: {
        documentId: "tides",
        documentName: "Tides.pdf",
        contentHash: "v1",
        pageFrom: 2,
        pageTo: 2,
        location: { kind: "page", from: 2, to: 2 },
        quote: SPRING,
        check: "found",
        checkReason: null,
      },
    };
    const cell = (value: string) => ({
      type: "tableCell",
      content: [{ type: "paragraph", content: [text(value)] }],
    });
    const table = (high: string) => ({
      type: "table",
      content: [{ type: "tableRow", content: [cell("High water"), cell(high)] }],
    });
    writeMind(client, [
      { type: "orderedList", attrs: { start: 1 }, content: [item("New moon"), item("Full moon")] },
      { type: "paragraph", content: [text("Spring tides come then. "), cited] },
      table("06:12"),
    ]);
    await client.settled();
    const earlier = await core.saveCheckpoint(mind.id, "accept");
    writeMind(client, [
      {
        type: "orderedList",
        attrs: { start: 1 },
        content: [item("First quarter"), item("New moon"), item("Full moon")],
      },
      { type: "paragraph", content: [text("Spring tides come then.")] },
      table("06:40"),
    ]);
    await client.settled();

    const { rows } = await core.compareCheckpoints({ mindId: mind.id, from: earlier.id, to: null });
    expect(rows.map((row) => [shown(row.left), shown(row.right), row.changed])).toEqual([
      [null, "{+First quarter+}", true],
      ["New moon", "New moon", false],
      ["Full moon", "Full moon", false],
      ["Spring tides come then.[- -][-⟨c⟩-]", "Spring tides come then.", true],
      ["High water · [-06:12-]", "High water · {+06:40+}", true],
    ]);
    expect(rows.map((row) => [row.left?.marker ?? null, row.right?.marker ?? null])).toEqual([
      [null, "1."],
      ["1.", "2."],
      ["2.", "3."],
      ["", ""],
      ["", ""],
    ]);
    expect(rows[3]?.left?.parts.at(-1)).toMatchObject({
      kind: "citation",
      change: "removed",
      work: { documentName: "Tides.pdf", location: { kind: "page", from: 2, to: 2 } },
    });
  });

  test("restoring is a new change after a Checkpoint of now, and restoring that takes it back", async () => {
    const core = startCore(await createTempDataFolder());
    const { mind, client } = await mindWith(core, ["Spring tides are the highest.", "Moon"]);
    const old = await core.saveCheckpoint(mind.id, "accept");
    writeMind(client, [note("Spring tides follow the new and full moon.")]);
    await client.settled();
    const vector = Y.decodeStateVector(Y.encodeStateVector(client.doc));

    const { before } = await core.restoreCheckpoint(mind.id, old.id);
    await client.settled();
    expect(lines(client)).toEqual(["Spring tides are the highest.", "Moon"]);
    // A change on top of what was there: every client's state only grows.
    const after = Y.decodeStateVector(Y.encodeStateVector(client.doc));
    expect(after.size).toBeGreaterThan(0);
    for (const [clientId, clock] of vector) {
      expect(after.get(clientId) ?? 0).toBeGreaterThanOrEqual(clock);
    }
    expect([...after.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(
      [...vector.values()].reduce((a, b) => a + b, 0),
    );
    expect(before.reason).toBe("restore");
    const list = await core.listCheckpoints(mind.id);
    expect(list.checkpoints.map((each) => each.id)).toEqual([before.id, old.id]);
    // What was there before is in History: compared with now, it is what was replaced.
    const compared = await core.compareCheckpoints({ mindId: mind.id, from: before.id, to: null });
    expect(compared.rows.map((row) => [shown(row.left), shown(row.right)])).toEqual([
      ["Spring tides [-follow the new and full moon-].", "Spring tides {+are the highest+}."],
      [null, "{+Moon+}"],
    ]);

    // Undo: restoring the Checkpoint of before.
    await core.restoreCheckpoint(mind.id, before.id);
    await client.settled();
    expect(lines(client)).toEqual(["Spring tides follow the new and full moon."]);
    // A second client opening the Mind now reads the same.
    const second = await connectToMind(core, mind.id);
    expect(lines(second)).toEqual(["Spring tides follow the new and full moon."]);
    await expect(core.restoreCheckpoint(mind.id, "nothing")).rejects.toThrow(NotFoundError);
  });

  test("a Mind of 300 Blocks: three changes among them are the only rows changed, and restore brings back every Block", async () => {
    const core = startCore(await createTempDataFolder());
    const original = Array.from({ length: 300 }, (_, index) =>
      index % 20 === 0 ? `Section ${index / 20 + 1}` : `Tide reading ${index}: 潮位 ${index} cm.`,
    );
    const { mind, client } = await mindWith(core, original);
    const old = await core.saveCheckpoint(mind.id, "accept");
    const edited = original.flatMap((text, index) =>
      index === 10
        ? []
        : index === 150
          ? ["Tide reading 150: 潮位 151 cm."]
          : index === 200
            ? ["Neap tide here.", text]
            : [text],
    );
    writeMind(
      client,
      edited.map((text) => note(text)),
    );
    await client.settled();

    const compared = await core.compareCheckpoints({ mindId: mind.id, from: old.id, to: null });
    expect(compared.changes).toBe(3);
    expect(compared.rows).toHaveLength(301);
    expect(
      compared.rows.filter((row) => row.changed).map((row) => [shown(row.left), shown(row.right)]),
    ).toEqual([
      ["[-Tide reading 10: 潮位 10 cm.-]", null],
      ["Tide reading 150: 潮位 [-150-] cm.", "Tide reading 150: 潮位 {+151+} cm."],
      [null, "{+Neap tide here.+}"],
    ]);

    await core.restoreCheckpoint(mind.id, old.id);
    await client.settled();
    expect(lines(client)).toEqual(original);
  });

  test("a version saved with changes still waiting comes back as History showed it, without them, but someone's from a Word file", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    const change = { id: "change-1", request: "request-1", target: "x" };
    const theirs = { id: "word:w:ins#2", request: "word:w:ins#2" };
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "The tides are " },
          { type: "text", text: "very", marks: [{ type: "proposalDelete", attrs: change }] },
          { type: "text", text: "a bit", marks: [{ type: "proposalInsert", attrs: change }] },
          { type: "text", text: " strong." },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Neap tides" },
          { type: "text", text: " are weak", marks: [{ type: "proposalInsert", attrs: theirs }] },
          { type: "text", text: "." },
        ],
      },
    ]);
    await client.settled();
    const waiting = await core.saveCheckpoint(mind.id, "accept");
    writeMind(client, [note("The tides are a bit strong.")]);
    await client.settled();

    const compared = await core.compareCheckpoints({ mindId: mind.id, from: waiting.id, to: null });
    expect(compared.rows.map((row) => [shown(row.left), shown(row.right)])).toEqual([
      ["The tides are [-very-] strong.", "The tides are {+a bit+} strong."],
      ["[-Neap tides.-]", null],
    ]);
    await core.restoreCheckpoint(mind.id, waiting.id);
    await client.settled();
    expect(lines(client)).toEqual(["The tides are very strong.", "Neap tides are weak."]);
    const marks: string[] = [];
    readMind(client).descendants((node) => {
      for (const mark of node.marks) marks.push(`${mark.type.name}:${node.text}`);
    });
    expect(marks).toEqual(["proposalInsert: are weak"]);
  });

  test("an Answer that was being written when it was saved comes back stopped", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    const asked = { type: "question", attrs: { id: "question-1" }, content: [] };
    writeMind(client, [
      { ...asked, content: [{ type: "text", text: "When are spring tides?" }] },
      {
        type: "answer",
        attrs: { id: "answer-1", questionId: "question-1", status: "streaming" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "At new and" }] }],
      },
    ]);
    await client.settled();
    const midway = await core.saveCheckpoint(mind.id, "regenerate");
    writeMind(client, [note("Spring tides, to look up.")]);
    await client.settled();

    await core.restoreCheckpoint(mind.id, midway.id);
    await client.settled();
    expect(answerIn(client, "answer-1").attrs.status).toBe("stopped");
    expect(lines(client)).toEqual(["When are spring tides?", "At new and"]);
  });

  test("a Mind a newer version wrote can be compared but not restored", async () => {
    const core = startCore(await createTempDataFolder());
    const { mind, client } = await mindWith(core, ["Tides"]);
    const old = await core.saveCheckpoint(mind.id, "accept");
    client.doc.getMap("settings").set("schemaVersion", 999);
    await client.settled();
    await expect(core.restoreCheckpoint(mind.id, old.id)).rejects.toThrow(MindReadOnlyError);
    expect((await core.listCheckpoints(mind.id)).checkpoints).toHaveLength(1);
  });

  test("deleting a Mind permanently drops its Checkpoints", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const { mind } = await mindWith(core, ["Tides"]);
    await core.saveCheckpoint(mind.id, "accept");
    await core.deleteMind(mind.id);
    expect(queryDatabase(dataDir, "SELECT id FROM mind_checkpoints")).toHaveLength(1);
    await core.deletePermanently([{ kind: "mind", id: mind.id }]);
    expect(queryDatabase(dataDir, "SELECT id FROM mind_checkpoints")).toEqual([]);
  });
});

const SPRING = "Spring tides happen at new moon and at full moon.";
const V1 = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["Spring and neap tides", SPRING] },
]);
const V2 = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides follow the new and the full moon."] },
]);

describe("Citations in Checkpoints", { timeout: 30_000 }, () => {
  test("Regenerate saves one; delete the Citation, restart, restore it: the Citation still checks", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id, pageFrom: 2, pageTo: 2, quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const setup = await setUpWithDocuments(model, [{ name: "Tides.pdf", contents: V1 }]);
    const { core, client, mind, dataDir } = setup;
    const document = setup.documents[0];
    if (!document) throw new Error("Nothing was added.");
    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    // Regenerate: a Checkpoint first, holding the Answer and its Citation.
    await core.regenerateAnswer({ mindId: mind.id, answerId });
    const [beforeRegenerate] = (await core.listCheckpoints(mind.id)).checkpoints;
    expect(beforeRegenerate?.reason).toBe("regenerate");
    await answerEnded(core, answerId);

    // The file changes, so version 1 is an old one; then the Answer, and its Citation, go.
    await writeFile(document.path, V2);
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);
    writeMind(client, [note("Spring tides, to look up again.")]);
    await client.settled();
    expect(() => answerIn(client, answerId)).toThrow();
    core.close();

    // Only the Checkpoint quotes version 1 now: its text stays.
    const again = startCore(dataDir, { createChatModel: setup.models.createChatModel });
    const pages = queryDatabase<{ text: string }>(
      dataDir,
      "SELECT text FROM document_pages WHERE content_hash = ? AND deleted_at IS NULL",
      [sha256(V1)],
    );
    expect(pages.map((page) => page.text).join("\n")).toContain(SPRING);

    const reopened = await connectToMind(again, mind.id);
    await again.restoreCheckpoint(mind.id, beforeRegenerate?.id ?? "");
    await reopened.settled();
    const citation = (() => {
      let found: Record<string, unknown> | null = null;
      answerIn(reopened, answerId).descendants((node) => {
        if (node.type.name === "citation") found = node.attrs;
      });
      return found as Record<string, unknown> | null;
    })();
    expect(citation).toMatchObject({
      documentId: document.id,
      contentHash: sha256(V1),
      check: "found",
    });
    // It checks against the version it quotes, which is still there to read.
    expect(citationState(citation ?? {}, await again.listDocuments())).toMatchObject({
      check: "found",
      changedAfterCited: true,
    });
  });
});
