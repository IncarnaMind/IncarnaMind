import { expect, test } from "vitest";
import { readVerdict } from "../../src/core/answers/checks/prompt";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

const CV = "58.com — Senior Design Manager (Apr 2016–Jul 2025). Led the homepage redesign.";
const JOB = "58.com — Senior Design Manager (Apr 2016–Jul 2025).";
const LEASE = "The Tenant may repaint the unit once the Landlord has agreed in writing.";

/** A Note of `sentences`, one paragraph each, checked as Check this Note checks it. */
async function checked(
  files: readonly { name: string; contents: string }[],
  sentences: readonly { text: string; cites?: { documentName: string; quote: string } }[],
  plans: Record<string, Plan>,
) {
  const calls: ModelCall[] = [];
  const { core, client, mind } = await setUpWithDocuments(checkingModel(plans, calls), files);
  writeMind(
    client,
    sentences.map(({ text, cites }, at) => ({
      type: "paragraph",
      attrs: { id: `p${at}` },
      content: cites
        ? [
            { type: "text", text: text.slice(0, -1) },
            { type: "citation", attrs: { ...cites, check: "found" } },
            { type: "text", text: text.slice(-1) },
          ]
        : [{ type: "text", text }],
    })),
  );
  await client.settled();
  await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
  await client.settled();
  const marks = claimSpans(readMind(client)).map((span) => span.check);
  core.close();
  return { marks, runs: calls.filter(isCheckRun) };
}

// protects=a sentence that names something with a number in it and cites the line that states it reads Supported, judged whole: the number is never taken out and checked alone (#3081); fails_when=the sentence reads Unsupported or Not checked, its check is told of a figure, or more than the sentence itself is sent to be judged; no_claim=that a model judges such a sentence right
test("a number inside a name is part of its sentence, which is judged whole", async () => {
  const { marks, runs } = await checked(
    [{ name: "CV.md", contents: CV }],
    [{ text: JOB, cites: { documentName: "CV", quote: JOB } }],
    { [JOB]: { verdict: "supported", quote: JOB, says: "The CV lists this post." } },
  );

  expect(marks.map((mark) => mark.state)).toEqual(["supported"]);
  expect(marks[0]?.figures).toBeUndefined();
  expect(marks[0]?.parts?.map((part) => [part.kind, part.verdict])).toEqual([
    ["fact", "supported"],
  ]);
  expect(new Set(runs.map(sentenceOf))).toEqual(new Set([JOB]));
  expect(runs.every((run) => !run.prompt.includes("<figures>"))).toBe(true);
  expect(runs[0]?.prompt).toContain("The User cites this");
});

// protects=the verdict a sentence's check gives is the model's: nothing in code lowers a Supported the model gave with a quote its Document holds; fails_when=a rule in code (a duty word, a unit, a figure, a part) turns the model's Supported into Unsupported or Not checked; no_claim=that the model is right to call it Supported
test("no rule in code overturns the model's verdict", async () => {
  const sentence = "The Tenant must repaint the unit, at a cost of 58 thousand.";
  const { marks } = await checked([{ name: "Lease.md", contents: LEASE }], [{ text: sentence }], {
    [sentence]: { verdict: "supported", quote: LEASE, says: "The lease lets the Tenant repaint." },
  });

  expect(marks.map((mark) => [mark.state, mark.evidence?.quote])).toEqual([["supported", LEASE]]);
});

// protects=the one thing code confirms: a Supported or Contradicted verdict rests on a quote its Document holds, so one whose quote isn't there is Not checked, never a ✓; fails_when=a verdict with a quote the Document doesn't hold, or with none, reads Supported or Contradicted; no_claim=which reason the card gives
test.each(["supported", "contradicted"] as const)(
  "a %s verdict whose quote isn't in the Document is not checked",
  async (verdict) => {
    const sentence = "The Tenant must repaint the unit every year.";
    const { marks } = await checked([{ name: "Lease.md", contents: LEASE }], [{ text: sentence }], {
      [sentence]: { verdict, quote: "The Tenant shall repaint the unit annually." },
    });

    expect(marks.map((mark) => mark.state)).toEqual(["not-checked"]);
  },
);

// protects=a contradiction the model gives with its quote reads Contradicted and offers the Document's words for the sentence's; an Unsupported reads Unsupported with the model's sentence; fails_when=either verdict is changed, the correction is lost, or it names words the sentence doesn't have; no_claim=how the card lays them out
test("a contradiction keeps its correction, and an unsupported sentence its reason", async () => {
  const wrong = "The Tenant must repaint the unit.";
  const absent = "The Tenant pays for the paint.";
  const { marks } = await checked(
    [{ name: "Lease.md", contents: LEASE }],
    [{ text: wrong }, { text: absent }],
    {
      [wrong]: {
        verdict: "contradicted",
        quote: LEASE,
        says: "The lease says the Tenant may repaint, not must.",
        change: { from: "must", to: "may" },
      },
      [absent]: { verdict: "unsupported", says: "The lease doesn't say who pays for the paint." },
    },
  );

  expect(marks.map((mark) => mark.state)).toEqual(["contradicted", "unsupported"]);
  expect(marks[0]?.parts?.[0]?.correction).toMatchObject({
    from: "must",
    choices: [{ wording: "may" }],
  });
  expect(marks[1]?.parts?.[0]?.unsupported?.reason).toBe(
    "The lease doesn't say who pays for the paint.",
  );
});

// protects=a check's reply is read wherever its fields stand: after a turn's own words with no line break, several on one line, or labelled in Chinese; a reply with no verdict reads as none; fails_when=a reply that gives its verdict is read as none (its sentence would be Not checked), or one that gives none is read as a verdict; no_claim=which fields a model writes.
test("a reply's fields are read wherever they stand on its lines", () => {
  expect(
    readVerdict(
      "Tides says so [^1].Verdict: supported\nExplanation: Tides says so. [^1]\nEvidence: [1]",
    ),
  ).toMatchObject({ verdict: "supported", says: "Tides says so.", evidence: [1] });
  expect(
    readVerdict(
      "Details: must / may, differs. Verdict: contradicted Explanation: The lease says may. [^2] Evidence: [2] Change 1: must To 1: may [^2]",
    ),
  ).toMatchObject({
    verdict: "contradicted",
    evidence: [2],
    correction: { from: "must", wording: "may", marker: 2 },
  });
  expect(readVerdict("结论：unsupported\n说明：文档没有说。\n证据：[]")).toMatchObject({
    verdict: "unsupported",
    says: "文档没有说。",
    evidence: [],
  });
  expect(readVerdict("I could not find it.")).toBeNull();
});
