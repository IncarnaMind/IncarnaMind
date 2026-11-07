import { expect, test } from "vitest";
import { createFactLedger } from "../../src/core/meetings/factLedger";
import type { FactReply, MeetingFact } from "../../src/core/meetings/factProtocol";

const fact = (id: string, text = id, supersedes: string[] = []): MeetingFact => ({
  id,
  topic: "draft",
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
    omitted: omittedIds.length + 1,
    invalidFrames: 0,
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
  ledger.accept({ ...reply(), overview, omitted: 0 });
  expect(ledger.overview).toEqual(overview);
  expect(ledger.omitted(true)).toBe(1);
});

test("the log learns why each item was left out, and the missing overview, never their words", () => {
  const ledger = createFactLedger();
  ledger.accept(reply([], ["A", "B"]));
  expect(ledger.omittedReasons(true)).toEqual({ citationNotFound: 2, overview: 1 });
  expect(ledger.omittedReasons(false)).toEqual({ citationNotFound: 2 });
});
