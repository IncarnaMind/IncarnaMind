import { expect, test } from "vitest";
import {
  FIND_CLAIMS_INSTRUCTIONS,
  FIND_OWN_CLAIMS_INSTRUCTIONS,
  FIND_OWN_LIBRARY_CLAIMS_INSTRUCTIONS,
} from "../../src/core/answers/checks/claims";
import { checkInstructions } from "../../src/core/answers/checks/prompt";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, checkReply, type Plan, requestedFigures } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

const OWN_LINES =
  "Absence: no\nScope: none, same\nTopic: found\nRoles: none / none, same\nTime: none / none, same\nDuty: none / none, same\nCondition: none / none, same";

const MEMBERS = "Members at 31 March numbered 2,360, against 2,105 a year before.";
const REPORT = `This is the report of the year. ${MEMBERS} The board has noted it.`;

const cite = (quote: string) => ({
  tool: "cite",
  input: { citations: [{ marker: 1, passage: "P1", quote }] },
});

/** Check this Note's mark for one sentence, sorted as one part, over the report. */
async function checked(claim: string, plan: Plan) {
  const looks: GenerateCall[] = [];
  const plans = { [claim]: plan };
  const model = scriptedModel((call) => checkReply(call, plans), {
    generate(call: GenerateCall) {
      if (call.question === "confirm" || call.question === "strict") looks.push(call);
      return checkGenerate(plans)(call);
    },
  });
  const { core, client, mind } = await setUpWithDocuments(model, [
    { name: "Report.md", contents: `${REPORT}\n` },
  ]);
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("checks", saved.service.id);
  writeMind(client, [
    { type: "paragraph", attrs: { id: "block-1" }, content: [{ type: "text", text: claim }] },
  ]);
  await client.settled();
  await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "block-1", offset: 0 },
    to: { blockId: "block-1", offset: claim.length },
  });
  await client.settled();
  const [span] = claimSpans(readMind(client));
  return { state: span?.check.state, looks };
}

const item = (id: string | undefined, number: string) => ({
  id,
  verdict: "supported",
  scope: "same",
  topic: "found",
  roles: "same",
  says: null,
  reading: null,
  relation: "equals",
  source: { citation: 1, number, reading: null, unitQuote: null },
  calculation: null,
});

/**
 * As Claude Haiku 5.5 checked the comparison whole: both figures found, and the comparison itself
 * judged as the Figures line's remainder. `closers`: closing braces written after the object.
 */
const wholeReply =
  (word: "above" | "below", verdict: "supported" | "contradicted", closers = "") =>
  (call: ModelCall) => {
    if (!call.results.some((result) => result.tool === "cite")) return { calls: [cite(MEMBERS)] };
    const [first, second] = requestedFigures(call);
    const figures = {
      items: [item(first?.id, "2,360"), item(second?.id, "2,105")],
      remainder: {
        text: `${word} the 2,105 of a year before`,
        verdict,
        scope: "same",
        topic: "found",
        roles: "same",
        says: null,
        citation: 1,
      },
    };
    return {
      text: `Verdict: ${verdict}\n${OWN_LINES}\nExplanation: The Document gives 2,360 at 31 March, against 2,105 a year before. [^1]\nEvidence: [1]\nFigures: ${JSON.stringify(figures)}${closers}`,
    };
  };

const sentence = (word: "above" | "below") =>
  `Membership was 2,360 at the end of March, ${word} the 2,105 of a year before.`;

// protects=a comparison checked in one part with the figure it is about is marked by what its reply says of the comparison, given as the Figures line's remainder with its number: the sentence that calls the greater figure the lower reads Contradicted, never ✓, and the right one ✓; the looks that confirm either are shown the whole sentence, never the comparison alone, which has lost what is above or below; fails_when=a remainder that holds the sentence's own figure is refused, so the right sentence ends Not checked, or the looks are shown "below the 2,105 of a year before" alone; no_claim=that a real model sorts the sentence whole, or judges the remainder right (the pull request's run counts both).
test("a comparison kept whole is marked by what its reply says of the comparison (#3223)", async () => {
  const right = await checked(sentence("above"), {
    judgement: "same",
    reply: wholeReply("above", "supported"),
  });
  const flipped = await checked(sentence("below"), {
    judgement: "conflict",
    reply: wholeReply("below", "contradicted"),
  });

  expect(right.state).toBe("supported");
  expect(flipped.state).toBe("contradicted");
  for (const { looks } of [right, flipped]) {
    expect(looks.length).toBeGreaterThan(0);
    for (const look of looks) expect(look.prompt).toContain("Membership was 2,360");
  }
});

// protects=a reply that takes the flipped comparison for right, both figures found and the comparison called supported, doesn't make the sentence ✓ alone: the looks read the whole sentence against its quote once more, and a conflict they uphold leaves it Unsupported; fails_when=the reply's own word is the only reader of the direction, as Claude Haiku 5.5 took the flipped sentence for right in 1 check of 18; no_claim=that the looks catch every such reply, or that a conflict they find is marked Contradicted.
test("a comparison called supported is read again, and a conflict takes the ✓ away (#3223)", async () => {
  const misread = await checked(sentence("below"), {
    judgement: "conflict",
    reply: wholeReply("below", "supported"),
  });

  expect(misread.state).toBe("unsupported");
});

// protects=a Figures line whose object is whole and followed by one closing brace too many is read as that object: Claude Haiku 5.5 closed the remainder twice in 5 of 26 replies, each an ask of the check's two; fails_when=the line can't be read, so the right sentence ends Not checked; two surplus braces, or anything else after the object, still can't be read; no_claim=that an object cut short is ever repaired.
test("one closing brace too many after the Figures line's object is read, two are not (#3223)", async () => {
  const one = await checked(sentence("above"), {
    judgement: "same",
    reply: wholeReply("above", "supported", "}"),
  });
  const two = await checked(sentence("above"), {
    judgement: "same",
    reply: wholeReply("above", "supported", "}}"),
  });

  expect(one.state).toBe("supported");
  expect(two.state).toBe("not-checked");
});

const KEPT = "stays with the amount it is about";

// protects=the rule that keeps "below the 342 of last year" in one part with the amount it is about is sent with every sort of a Note or a document, and says that two amounts side by side with no such word stay two parts; a check that finds its own parts is sent what it was sent before; fails_when=the rule is dropped from a sort, so the comparison is checked as a part that has lost what is below, or it is added to a check's own instructions, a flow it was never measured in; no_claim=that a model follows it.
test("the rule that keeps a comparison with its amount is sent with every sort, and with no check (#3223)", () => {
  for (const sort of [
    FIND_CLAIMS_INSTRUCTIONS,
    FIND_OWN_CLAIMS_INSTRUCTIONS,
    FIND_OWN_LIBRARY_CLAIMS_INSTRUCTIONS,
  ]) {
    expect(sort).toContain(KEPT);
    expect(sort).toContain("remain separate parts");
  }
  expect(checkInstructions("tools", "en", "", false, false, true)).not.toContain(KEPT);
});
