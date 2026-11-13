/**
 * The ask for a check's missing Citation records (#3019): it names what each marker was for, in the
 * verdict's own Evidence and Covered lines, and says a bracketed number inside a Passage is the
 * Document's own reference. Asked for markers alone, Claude Haiku 5.5 gave a paper's [1] and [2].
 */
import { describe, expect, test } from "vitest";
import { checkGenerate, checkReply, SAME_DETAIL } from "../helpers/checks";
import { type SourceFile, setUpWithDocuments } from "../helpers/citations";
import { type GenerateCall, scriptedModel } from "../helpers/models";

const TIDES: SourceFile = {
  name: "Tides.md",
  contents:
    "The tide turns twice a day [1].\n\nThe harbour closes at dusk [2].\n\n潮水每天涨落两次 [1]。\n\n港口在黄昏关闭 [2]。\n",
};

describe("The ask for a check's missing records", { timeout: 30_000 }, () => {
  // protects=a check whose verdict names its Evidence markers and Covered words but records none asks for them with its own Evidence and Covered lines, and the line that a number in square brackets inside a Passage is the Document's own reference, in English and Chinese; fails_when=the ask names the markers alone, as on main; no_claim=what a real model answers, which the gate measures.
  test.each([
    ["English", "The tide turns twice a day, and the harbour closes at dusk."],
    ["Chinese", "潮水每天涨落两次，港口在黄昏关闭。"],
  ])("%s", async (_language, claim) => {
    const asked: string[] = [];
    const reply = [
      "Verdict: supported",
      "Absence: no",
      SAME_DETAIL,
      "Explanation: The Document says both.",
      "Evidence: [1, 2]",
      "Covered: the tide turning twice a day, and the harbour closing at dusk",
    ].join("\n");
    const plans = { [claim]: { verdict: "supported" as const, reply: { text: reply } } };
    const model = scriptedModel((call) => checkReply(call, plans), {
      generate: (call: GenerateCall) => {
        if (call.question === "evidence") {
          asked.push(call.prompt);
          return { text: '{"citations":[]}' };
        }
        return checkGenerate(plans)(call);
      },
    });
    const { core } = await setUpWithDocuments(model, [TIDES]);
    await core.checkClaim({ claim });
    const [ask] = asked;
    expect(ask).toContain("Missing Citation markers: [1,2]");
    expect(ask).toContain(
      "They are the markers of your verdict's own lines. Evidence: [1,2]. Covered: the tide turning twice a day, and the harbour closing at dusk",
    );
    expect(ask).toContain(
      "A number in square brackets inside a Passage, such as [1], is the Document's own reference, never one of these markers.",
    );
  });
});
