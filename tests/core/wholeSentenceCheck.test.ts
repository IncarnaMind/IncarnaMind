import { expect, test } from "vitest";
import { readVerdict } from "../../src/core/answers/checks/prompt";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { isOwnView } from "../../src/shared/claimParts";
import { readOpinionSentences } from "../../src/shared/opinions";
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

// protects=the way a check's model says a sentence goes beyond its Documents (overstated, partly supported, not found) stays on its result: the sentence reads Unsupported with that word, and keeps the quote of what the Document does say; a reply that says only "unsupported" carries no word; fails_when=the word is lost or changed, such a sentence reads anything but Unsupported, or the quote of what the Document says is dropped; no_claim=that a model picks the right word
test("an unsupported sentence keeps the word its model gave for it", async () => {
  const stronger = "The Tenant may repaint the unit.";
  const more = "The Tenant may repaint the unit in any colour.";
  const absent = "The Tenant pays for the paint.";
  const { marks } = await checked(
    [{ name: "Lease.md", contents: LEASE }],
    [{ text: stronger }, { text: more }, { text: absent }],
    {
      [stronger]: {
        verdict: "overstated",
        quote: LEASE,
        says: "The lease lets the Tenant repaint only once the Landlord has agreed in writing.",
      },
      [more]: {
        verdict: "partly supported",
        quote: LEASE,
        says: "The lease doesn't say which colour.",
      },
      [absent]: { verdict: "not found", says: "The lease doesn't say who pays for the paint." },
    },
  );

  expect(marks.map((mark) => [mark.state, mark.unsupported?.word])).toEqual([
    ["unsupported", "overstated"],
    ["unsupported", "partly-supported"],
    ["unsupported", "not-found"],
  ]);
  expect(marks.map((mark) => mark.unsupported?.quoted?.quote ?? null)).toEqual([
    LEASE,
    LEASE,
    null,
  ]);
  expect(marks[0]?.unsupported?.reason).toBe(
    "The lease lets the Tenant repaint only once the Landlord has agreed in writing.",
  );
  expect(readVerdict("Verdict: unsupported\nEvidence: []")).toEqual({
    verdict: "unsupported",
    says: null,
    evidence: [],
  });
});

// protects=a sentence its check's model calls the writer's own view (advice, a judgement) keeps a mark that says so, with the model's words on what the Documents hold and the quote of the fact it names, and is never Unsupported's fault or left out unread (#3322); fails if such a sentence gets no mark, or its mark loses the word, the reason or the quote
test("a sentence the check's model calls the writer's own view keeps a mark that says so, with what the Documents hold on it", async () => {
  const advice = "My advice: the Tenant should repaint the unit with 2 coats before 14 March.";
  const holds =
    "The lease lets the Tenant repaint once the Landlord agrees, and names no number of coats.";
  const plans: Record<string, Plan> = {
    [LEASE]: { verdict: "supported", quote: LEASE, says: "The lease says so." },
    [advice]: { verdict: "own view", quote: LEASE, says: holds },
  };
  const { core, client, mind } = await setUpWithDocuments(checkingModel(plans), [
    { name: "Lease.md", contents: LEASE },
  ]);
  writeMind(
    client,
    [LEASE, advice].map((sentence, at) => ({
      type: "paragraph",
      attrs: { id: `p${at}` },
      content: [{ type: "text", text: sentence }],
    })),
  );
  await client.settled();
  const ran = await core.checkMind({
    requestId: crypto.randomUUID(),
    mindId: mind.id,
    mode: "all",
  });
  await client.settled();
  const view = claimSpans(readMind(client)).find((span) => span.sentence.text === advice);
  core.close();

  expect(ran).toMatchObject({ kind: "checked", sentences: 2, checked: 2 });
  expect(view?.check.state).toBe("unsupported");
  expect(
    view && isOwnView({ verdict: view.check.state, unsupported: view.check.unsupported }),
  ).toBe(true);
  expect(view?.check.unsupported).toMatchObject({ reason: holds, quoted: { quote: LEASE } });
  expect(readOpinionSentences(client.doc)).toEqual([]);
});

// protects=a verdict the check's model worked out from the Documents keeps its one line of working on the sentence's mark, and a reply that says "Working: none" keeps none (#3322); fails if the working is dropped on the way to the mark, or "none" is stored as a working
test("a verdict worked out from the Documents keeps its line of working", async () => {
  const total = "So the Tenant can't repaint before the Landlord agrees.";
  const working = "repainting needs the agreement first, so not before it";
  const plans: Record<string, Plan> = {
    [total]: { verdict: "supported", quote: LEASE, says: "The lease sets the order.", working },
  };
  const { core, client, mind } = await setUpWithDocuments(checkingModel(plans), [
    { name: "Lease.md", contents: LEASE },
  ]);
  writeMind(client, [
    { type: "paragraph", attrs: { id: "p0" }, content: [{ type: "text", text: total }] },
  ]);
  await client.settled();
  await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
  await client.settled();
  const [span] = claimSpans(readMind(client));
  core.close();

  expect(span?.check.state).toBe("supported");
  expect(span?.check.parts?.[0]?.workedOut).toBe(working);
  expect(readVerdict(`Verdict: supported\nEvidence: [1]\nWorking: ${working}`)?.working).toBe(
    working,
  );
  expect(readVerdict("Verdict: supported\nEvidence: [1]\nWorking: none")?.working).toBeUndefined();
  expect(readVerdict("Verdict: supported\nEvidence: [1]\nWorking: 无")?.working).toBeUndefined();
});

// protects=a Chinese explanation that holds a label's word before a colon ("这是作者的判断：…") is read whole, with the verdict the reply gave (#3322); fails if such a reply reads as no verdict, or its explanation is cut at the colon
test("a Chinese explanation with a label's word inside it is read whole", () => {
  const says = "这是作者的判断：文档没有给出结论：只写了工单量会增长。";
  expect(readVerdict(`Verdict: own view\nExplanation: ${says}\nEvidence: []`)).toMatchObject({
    verdict: "unsupported",
    word: "own-view",
    says,
  });
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
