/**
 * Typing in a long Note keeps up (#746). What the core does with a key the User types, and with
 * the figure schedule the window asks for after it, reads only the Block the key changed, and
 * only the rows that key changed cross to the window: a key costs a 2,000-paragraph Note what it
 * costs a 20-paragraph one. Counted as the reads of the Note's document the core makes and the
 * rows it gives, not as time. A Block's kept read is never one a change has since outdated.
 */
import type { JSONContent } from "@tiptap/core";
import { expect, test, vi } from "vitest";
import * as Y from "yjs";
import { type CoreBridge, type FigureSchedule, MIND_CONTENT_FIELD } from "../../src/core/api";
import { applyFigureScheduleChange } from "../../src/shared/figureSchedule";
import { perBlock } from "../../src/shared/memo";
import { fingerprintOfMind } from "../../src/shared/mindState";
import { createTempDataFolder, startCore } from "../helpers/core";
import { appendParagraph, connectToMind, typeInto } from "../helpers/mindClient";
import { editMind, heading, note, writeMind } from "../helpers/minds";

const clauses = (count: number): JSONContent[] =>
  Array.from({ length: count }, (_, at) =>
    note(`Clause ${at + 1}. The fee is $1,250 a month, due within 30 days of the invoice.`),
  );

/** Asks for the schedule as the window does, as a change to the one it holds. */
function scheduleAsked(core: CoreBridge, mindId: string) {
  let held: { token: string; schedule: FigureSchedule } | null = null;
  return async () => {
    const change = await core.getFigureScheduleChange(mindId, held?.token ?? null);
    const schedule = applyFigureScheduleChange(held, change);
    if (!schedule) throw new Error("The change isn't to the schedule held.");
    held = { token: change.token, schedule };
    return { schedule, given: change.rows.length };
  };
}

/** The reads one key in the middle of the Note takes, and the schedule the window gets after it. */
async function oneKey(paragraphs: number) {
  const core = startCore(await createTempDataFolder());
  const mind = await core.createMind({ title: "Services agreement" });
  const client = await connectToMind(core, mind.id);
  const ask = scheduleAsked(core, mind.id);
  writeMind(client, clauses(paragraphs));
  await client.settled();
  await ask();
  const middle = Math.floor(paragraphs / 2);
  typeInto(client, middle, 0, "A");
  await client.settled();
  await ask();

  const reads = [
    vi.spyOn(Y.XmlFragment.prototype, "toArray"),
    vi.spyOn(Y.XmlElement.prototype as { toString(): string }, "toString"),
    vi.spyOn(Y.XmlElement.prototype, "getAttribute"),
    vi.spyOn(Y.XmlElement.prototype, "getAttributes"),
    vi.spyOn(Y.Text.prototype, "toDelta"),
  ];
  typeInto(client, middle, 1, " ");
  await client.settled();
  const { schedule, given } = await ask();
  const counted = reads.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  vi.restoreAllMocks();
  return {
    reads: counted,
    given,
    schedule,
    whole: await core.getFigureSchedule(mind.id),
    basis: fingerprintOfMind(client.doc),
  };
}

test("a key in a 2,000-paragraph Note reads and sends no more of it than a key in a 20-paragraph one", async () => {
  const short = await oneKey(20);
  const long = await oneKey(2_000);
  // The window has the whole schedule for the Note as typed, every clause's figures in it.
  expect(long.schedule).toEqual(long.whole);
  expect(long.schedule.basis).toBe(long.basis);
  expect(short.schedule).toEqual(short.whole);
  expect(long.whole.rows.length).toBe(100 * short.whole.rows.length);
  expect(short.reads).toBeGreaterThan(0);
  expect(long.reads).toBeLessThanOrEqual(short.reads * 2);
  // The typed clause's figures moved along, and only they were sent.
  expect(short.given).toBeGreaterThan(0);
  expect(long.given).toBe(short.given);
}, 120_000);

test("the schedule asked for as changes after each edit is the one read whole", async () => {
  const core = startCore(await createTempDataFolder());
  const mind = await core.createMind({ title: "Services agreement" });
  const client = await connectToMind(core, mind.id);
  const ask = scheduleAsked(core, mind.id);
  writeMind(client, [heading(1, "Fees"), ...clauses(30)]);
  await client.settled();
  const edits: (() => void)[] = [
    () => typeInto(client, 5, 0, "7 "),
    () => typeInto(client, 1, 0, "Each "),
    () => appendParagraph(client, "A late payment costs 2% a month."),
    () =>
      editMind(client, (blocks) => [
        ...blocks.slice(0, 10),
        heading(2, "Late fees in 2027"),
        ...blocks.slice(10),
      ]),
    () => editMind(client, (blocks) => blocks.filter((_, at) => at !== 3)),
    () =>
      editMind(client, (blocks) => [
        ...blocks.slice(0, 15),
        note("A new clause, for 45 units."),
        ...blocks.slice(15),
      ]),
    () => typeInto(client, 0, 0, "Payment "),
  ];
  for (const edit of edits) {
    edit();
    await client.settled();
    const { schedule } = await ask();
    expect(schedule).toEqual(await core.getFigureSchedule(mind.id));
    expect(schedule.basis).toBe(fingerprintOfMind(client.doc));
  }
});

const paragraphOf = (text: string) => {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  return paragraph;
};
const textIn = (block: Y.XmlElement) => {
  const text = block.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("The Block holds no text.");
  return text;
};

test("a Block read in a transaction after another Block is deleted is the Block as it is now", () => {
  const read = perBlock((block) => block.toString());
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  blocks.insert(0, [paragraphOf("x"), paragraphOf("b")]);
  const [x, b] = blocks.toArray().filter((each) => each instanceof Y.XmlElement);
  if (!x || !b) throw new Error("The Blocks weren't made.");
  read(b);
  let inside = "";
  doc.transact(() => {
    textIn(x).insert(0, "typed ");
    blocks.insert(2, [paragraphOf("new")]);
    read(b);
    textIn(b).insert(0, "B now ");
    // Deleting x takes its text out of the changed types, so as many types count as changed as when b was read.
    blocks.delete(0, 1);
    inside = read(b);
  });
  expect(inside).toBe("<paragraph>B now b</paragraph>");
  expect(read(b)).toBe("<paragraph>B now b</paragraph>");
});

test("a Block read while observers run is the Block as an observer's own change left it", () => {
  const read = perBlock((block) => block.toString());
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  blocks.insert(0, [paragraphOf("first"), paragraphOf("second")]);
  const [first, second] = blocks.toArray().filter((each) => each instanceof Y.XmlElement);
  if (!first || !second) throw new Error("The Blocks weren't made.");
  read(second);
  const seen: string[] = [];
  let changing = false;
  blocks.observeDeep(() => {
    if (changing) return;
    changing = true;
    doc.transact(() => textIn(second).insert(0, "CHANGED "));
    seen.push(read(second));
  });
  textIn(first).insert(0, "typed ");
  expect(seen).toEqual(["<paragraph>CHANGED second</paragraph>"]);
  expect(read(second)).toBe("<paragraph>CHANGED second</paragraph>");
});
