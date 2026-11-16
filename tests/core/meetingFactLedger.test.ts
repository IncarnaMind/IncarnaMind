import { expect, test } from "vitest";
import { createFactLedger } from "../../src/core/meetings/factLedger";
import type { FactReply, MeetingFact } from "../../src/core/meetings/factProtocol";

const fact = (id: string, text = id, supersedes: string[] = []): MeetingFact => ({
  id,
  topic: "draft",
  heading: "Draft",
  lines: [],
  sections: ["actions"],
  claim: false,
  supersedes,
  body: { type: "paragraph", content: [{ type: "text", text }] },
  citations: [],
});

function reply(facts: MeetingFact[] = [], omittedIds: string[] = []): FactReply {
  return {
    facts,
    omittedIds,
    omittedReasons: Object.fromEntries(omittedIds.map((id) => [id, "citationNotFound" as const])),
    overview: null,
    overviewOmitted: "missing",
    omitted: omittedIds.length + 1,
    invalidFrames: 0,
    cut: false,
  };
}

test("a replay cannot restore a superseded agreement", () => {
  const ledger = createFactLedger();
  const first = fact("P1_F1", "Dana sends it Monday.");
  const final = fact("P2_F1", "Dana sends it Friday.", [first.id]);
  ledger.accept(reply([first]));
  ledger.accept(reply([final]));
  ledger.accept(reply([first]));
  expect(ledger.facts).toEqual([final]);
  expect(ledger.omitted(false)).toBe(0);
});

test("chained corrections retain their identities for the whole fill", () => {
  const ledger = createFactLedger();
  const first = fact("A");
  const second = fact("B", "second", ["A"]);
  const final = fact("C", "final", ["B"]);
  for (const next of [first, second, final, first, second]) ledger.accept(reply([next]));
  expect(ledger.facts).toEqual([final]);
  expect(ledger.omitted(false)).toBe(0);
});

test("a known failed identity is counted once across parts", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([], ["Bad"]));
  ledger.accept(reply([], ["Bad"]));
  expect(ledger.facts).toEqual([]);
  expect(ledger.omitted(false)).toBe(1);
});

test("a later verified fact reconciles its earlier omission", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([], ["A"]));
  ledger.accept(reply([fact("A")]));
  expect(ledger.facts).toEqual([fact("A")]);
  expect(ledger.omitted(false)).toBe(0);
});

test("an invalid repeated frame does not discard or recount a retained identity", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([fact("A")]));
  ledger.accept(reply([], ["A"]));
  expect(ledger.facts).toEqual([fact("A")]);
  expect(ledger.omitted(false)).toBe(0);
});

test("dangling corrections leave accepted facts intact and count the rejected identity once", () => {
  const ledger = createFactLedger();
  const original = fact("A");
  const invalid = fact("B", "invalid", ["Unknown"]);
  ledger.accept(reply([original]));
  ledger.accept(reply([invalid]));
  ledger.accept(reply([invalid]));
  expect(ledger.facts).toEqual([original]);
  expect(ledger.omitted(false)).toBe(1);
  const final = fact("B", "final", ["A"]);
  ledger.accept(reply([final]));
  expect(ledger.facts).toEqual([final]);
  expect(ledger.omitted(false)).toBe(0);
});

test("self-corrections cannot delete their own identity", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([fact("A", "invalid", ["A"])]));
  expect(ledger.facts).toEqual([]);
  expect(ledger.omitted(false)).toBe(1);
});

test("identical retained frames are silent, conflicting identity variants are counted once", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([fact("A")]));
  ledger.accept(reply([fact("A")]));
  expect(ledger.omitted(false)).toBe(0);
  ledger.accept(reply([fact("A", "conflict")]));
  ledger.accept(reply([fact("A", "conflict")]));
  expect(ledger.facts).toEqual([fact("A")]);
  expect(ledger.omitted(false)).toBe(1);
});

test("unknown frames are not counted as known omitted additions", () => {
  const ledger = createFactLedger();
  ledger.accept({ ...reply([], ["Bad"]), invalidFrames: 2 });
  ledger.accept(reply([], ["Bad"]));
  expect(ledger.invalidFrames).toBe(2);
  expect(ledger.omitted(false)).toBe(1);
  expect(ledger.omitted(true)).toBe(2);
  const overview = { body: { type: "paragraph" }, citations: [] };
  ledger.accept({ ...reply(), overview, overviewOmitted: null, omitted: 0 });
  expect(ledger.overviews).toEqual([overview]);
  expect(ledger.omitted(true)).toBe(1);
});

test("each reply's overview is kept, in the order the replies came (#3151)", () => {
  const ledger = createFactLedger();
  const overviews = ["first", "second"].map((text) => ({
    body: { type: "paragraph", content: [{ type: "text", text }] },
    citations: [],
  }));
  ledger.accept({ ...reply(), overview: overviews[0] ?? null, overviewOmitted: null, omitted: 0 });
  ledger.accept(reply());
  ledger.accept({ ...reply(), overview: overviews[1] ?? null, overviewOmitted: null, omitted: 0 });
  expect(ledger.overviews).toEqual(overviews);
  expect(ledger.omitted(true)).toBe(0);
});

test("the log learns why each item was left out, and the missing overview, never their words", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([], ["A", "B"]));
  expect(ledger.omittedReasons(true)).toEqual({
    citationNotFound: 2,
    overview: 1,
    overviewReason: "missing",
  });
  expect(ledger.omittedReasons(false)).toEqual({ citationNotFound: 2 });
});

test("the log keeps why an overview was left out when a later part writes none (#3145)", () => {
  const ledger = createFactLedger();
  ledger.accept({ ...reply(), overviewOmitted: "markers" });
  ledger.accept(reply());
  expect(ledger.omittedReasons(true)).toEqual({ overview: 1, overviewReason: "markers" });
  const overview = { body: { type: "paragraph" }, citations: [] };
  ledger.accept({ ...reply(), overview, overviewOmitted: null, omitted: 0 });
  expect(ledger.omittedReasons(true)).toEqual({});
});

test("a fact may replace one written after it in the same reply", () => {
  const ledger = createFactLedger();
  const decision = fact("P1_F1", "最终定一位摄影师全天跟拍，九千八百元。", ["P1_F2"]);
  const proposal = fact("P1_F2", "对方先推荐两位摄影师的方案，一万五千八百元。");
  ledger.accept(reply([decision, proposal]));
  expect(ledger.facts).toEqual([decision]);
  expect(ledger.omitted(false)).toBe(0);
  ledger.accept(reply([proposal]));
  expect(ledger.facts).toEqual([decision]);
});

test("a fact replacing one left out for its Citation is kept", () => {
  const ledger = createFactLedger();
  const decision = fact("P1_F1", "The final price is 13 dollars a box.", ["P1_F2"]);
  ledger.accept(reply([decision], ["P1_F2"]));
  expect(ledger.facts).toEqual([decision]);
  expect(ledger.omitted(false)).toBe(0);
});

test("a fact naming an id no reply has given is still left out", () => {
  const ledger = createFactLedger();
  const decision = fact("P1_F1", "The final price is 13 dollars a box.", ["P1_F9"]);
  const other = fact("P1_F2", "Dev photographs the boxes by 9 March.");
  ledger.accept(reply([decision, other]));
  expect(ledger.facts).toEqual([other]);
  expect(ledger.omittedReasons(false)).toEqual({ supersedes: 1 });
});

test("two facts that replace each other are both left out, and counted", () => {
  const ledger = createFactLedger();
  const first = fact("P1_F1", "The launch is 19 March.", ["P1_F2"]);
  const second = fact("P1_F2", "The launch is 12 March.", ["P1_F1"]);
  const other = fact("P1_F3", "Dev photographs the boxes by 9 March.");
  ledger.accept(reply([first, second, other]));
  expect(ledger.facts).toEqual([other]);
  expect(ledger.omittedReasons(false)).toEqual({ supersedes: 2 });
  const chain = fact("P2_F1", "C", ["P2_F2"]);
  const middle = fact("P2_F2", "B", ["P2_F3"]);
  const last = fact("P2_F3", "A");
  ledger.accept(reply([chain, middle, last]));
  expect(ledger.facts).toEqual([other, chain]);
});

test("a fact replaced while it was left out doesn't come back later", () => {
  const ledger = createFactLedger();
  const decision = fact("P1_F1", "The final price is 13 dollars a box.", ["P1_F2"]);
  ledger.accept(reply([decision], ["P1_F2"]));
  ledger.accept(reply([fact("P1_F2", "The price is 16 dollars a box.")]));
  expect(ledger.facts).toEqual([decision]);
  expect(ledger.omitted(false)).toBe(0);
});

/** `fact` on `topic`, citing the Transcript line that starts at `from` ms. */
const citing = (
  from: number,
  id: string,
  topic: string,
  supersedes: string[] = [],
): MeetingFact => ({
  ...fact(id, `${topic} at ${from}`, supersedes),
  topic,
  citations: [
    {
      type: "citation",
      attrs: { documentId: "transcript", location: { kind: "time", from, to: from + 900 } },
    },
  ],
});

// protects=a later reply's fact under an id a kept fact has, with another topic and citing another line, is another fact: both are kept, in order, the later one under an id of its own that no kept, left-out or replaced fact has, and nothing is counted (#3145); fails_when=the later fact is dropped or counted, replaces the kept one, or shares an id; no_claim=which ids a real model reuses.
test("a kept id reused for another topic at another line gives two facts, each with its own id (#3145)", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([citing(1_000, "P1_F1", "venue"), citing(2_000, "P1_F1_2", "budget")]));
  ledger.accept(reply([citing(60_000, "P1_F1", "hiring")], ["P1_F1_3"]));
  ledger.accept(reply([citing(90_000, "P1_F1", "launch date")]));
  expect(ledger.facts.map((each) => each.topic)).toEqual([
    "venue",
    "budget",
    "hiring",
    "launch date",
  ]);
  const ids = ledger.facts.map((each) => each.id);
  expect(ids.slice(0, 2)).toEqual(["P1_F1", "P1_F1_2"]);
  for (const [index, id] of ids.entries()) {
    expect(ids.indexOf(id)).toBe(index);
    expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
    expect(id).not.toBe("P1_F1_3");
  }
  expect(ledger.omitted(false)).toBe(1);
  expect(ledger.omittedReasons(false)).toEqual({ citationNotFound: 1 });
});

// protects=a kept fact can't be rewritten through its id: a later reply's fact under that id on the same topic, or at the same line, is left out and counted once, and the kept fact stays, as before (#3145); fails_when=a rewrite is kept beside or in place of the kept fact, or isn't counted; no_claim=a fact with another topic at another line, which is read as another fact.
test.each([
  { rewrite: "the same topic at another line", from: 60_000, topic: "venue" },
  { rewrite: "another topic at the same line", from: 1_000, topic: "venue choice" },
])("a kept id rewritten with $rewrite is still left out, and counted", ({ from, topic }) => {
  const ledger = createFactLedger();
  const kept = citing(1_000, "A", "venue");
  ledger.accept(reply([kept]));
  ledger.accept(reply([citing(from, "A", topic)]));
  expect(ledger.facts).toEqual([kept]);
  expect(ledger.omitted(false)).toBe(1);
  expect(ledger.omittedReasons(false)).toEqual({ changed: 1 });
});

// protects=a replaced fact doesn't come back when a later reply repeats it at another line, as before, while its id reused for another topic is another fact (#3145); fails_when=the replaced fact returns, or the other fact is dropped; no_claim=how often a model repeats a replaced fact.
test("a replaced fact repeated at another line stays out, and its id reused for another topic is kept", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([citing(1_000, "A", "review day")]));
  ledger.accept(reply([citing(30_000, "B", "review day", ["A"])]));
  ledger.accept(reply([citing(60_000, "A", "review day"), citing(61_000, "B", "checklist")]));
  expect(ledger.facts.map((each) => [each.topic, each.citations[0]?.attrs?.location])).toEqual([
    ["review day", { kind: "time", from: 30_000, to: 30_900 }],
    ["checklist", { kind: "time", from: 61_000, to: 61_900 }],
  ]);
  expect(ledger.omitted(false)).toBe(0);
});

// protects=a long id reused for another fact still gets an id the reply reader accepts, so a later reply can name it (#3145); fails_when=the new id is longer than 32 characters or equals the kept one; no_claim=the id's exact words.
test("a reused id of the greatest length still gets a valid id of its own", () => {
  const ledger = createFactLedger();
  const long = `P${"x".repeat(31)}`;
  ledger.accept(reply([citing(1_000, long, "venue")]));
  ledger.accept(reply([citing(60_000, long, "budget")]));
  const ids = ledger.facts.map((each) => each.id);
  expect(ids).toHaveLength(2);
  expect(ids[1]).not.toBe(long);
  expect(ids[1]).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
});

// protects=a fact kept under an id of its own is one fact from then on: written again under the id the model used, it is silent when the same and left out and counted when reworded, and once replaced it doesn't come back (#3145); fails_when=a repeat is kept as a second fact, a rewording is kept, or a replaced fact returns under a new id; no_claim=how often a model repeats a fact.
test("a fact kept under its own id is the same fact when the model writes it again", () => {
  const ledger = createFactLedger();
  const venue = citing(1_000, "A", "venue");
  const hiring = citing(60_000, "A", "hiring");
  ledger.accept(reply([venue]));
  ledger.accept(reply([hiring]));
  ledger.accept(reply([hiring]));
  expect(ledger.facts.map((each) => each.topic)).toEqual(["venue", "hiring"]);
  expect(ledger.omitted(false)).toBe(0);
  ledger.accept(reply([{ ...hiring, lines: ["L1"] }]));
  expect(ledger.facts.map((each) => [each.topic, each.lines])).toEqual([
    ["venue", []],
    ["hiring", []],
  ]);
  expect(ledger.omittedReasons(false)).toEqual({ changed: 1 });
  const own = ledger.facts[1]?.id ?? "";
  ledger.accept(reply([citing(90_000, "B", "hiring", [own])]));
  ledger.accept(reply([hiring]));
  expect(ledger.facts.map((each) => [each.id, each.topic])).toEqual([
    ["A", "venue"],
    ["B", "hiring"],
  ]);
});

// protects=a fact that names its own id in supersedes never deletes the kept fact that has that id, whatever its topic and lines: it is left out and counted, and the kept fact stays (#3145); fails_when=the kept fact goes, or the fact is kept; no_claim=what the model meant by it.
test("a fact reusing a kept id that names that id in supersedes can't delete the kept fact", () => {
  const ledger = createFactLedger();
  const kept = citing(1_000, "A", "venue");
  ledger.accept(reply([kept]));
  ledger.accept(reply([citing(60_000, "A", "hiring", ["A"])]));
  expect(ledger.facts).toEqual([kept]);
  expect(ledger.omitted(false)).toBe(1);
});

// protects=a fact left out under an id of its own is counted once however often the model writes it again, and is kept under that id once it is written right (#3145); fails_when=each repeat adds one to the items not added, or the right one is kept under yet another id; no_claim=how often a model repeats a fact.
test("a fact left out under its own id is counted once when written again, and kept once right", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([citing(1_000, "A", "venue")]));
  const unknown = citing(60_000, "A", "hiring", ["Nobody"]);
  ledger.accept(reply([unknown]));
  ledger.accept(reply([unknown]));
  ledger.accept(reply([unknown]));
  expect(ledger.facts.map((each) => each.topic)).toEqual(["venue"]);
  expect(ledger.omittedReasons(false)).toEqual({ supersedes: 1 });
  ledger.accept(reply([citing(60_000, "A", "hiring")]));
  expect(ledger.facts.map((each) => each.topic)).toEqual(["venue", "hiring"]);
  expect(ledger.omitted(false)).toBe(0);
});
