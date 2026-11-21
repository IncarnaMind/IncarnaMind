/**
 * The evaluation's request log ties each request a check makes to the sentence it is for (#2256):
 * every request the scripted model receives is logged once, against that sentence, from the tag
 * the check gives it, not from the request's words.
 */
import { describe, expect, test } from "vitest";
import { watchRequests } from "../../eval/repeats/requests";
import { checkNow } from "../../src/core/answers/checks/checkedText";
import { checkGenerate, checkReply, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";

const AGREEMENT = {
  name: "Agreement.md",
  contents: "# Agreement\n\nThe salary is 60,000 per year, paid monthly in arrears.\n",
};
const SALARY = "The salary is 65,000 per year, paid monthly in arrears.";
const PLANS: Record<string, Plan> = {
  [SALARY]: {
    verdict: "contradicted",
    quote: "The salary is 60,000 per year",
    says: "The agreement says 60,000, not 65,000.",
    change: { from: "65,000", to: "60,000" },
  },
};

/** A request the model received: whether it is a check's Run, and the sentence it was tagged with. */
type Received = { run: boolean; tag: string | null };

/** A model that searches, cites the agreement's line and finds the sentence contradicted. */
function model(received: Received[]) {
  const see = (system: string) =>
    received.push({
      run: system.startsWith("You check one sentence"),
      tag: checkNow()?.sentence ?? null,
    });
  return scriptedModel(
    (call) => {
      see(call.system);
      return checkReply(call, PLANS);
    },
    {
      generate: (call) => {
        see(call.system);
        return checkGenerate(PLANS)(call);
      },
    },
  );
}

describe("The evaluation's request log", () => {
  // protects=every request a check makes is logged once against its sentence, by the tag the check gives it, as the checks evaluation reads its judge's replies; fails_when=a request of the check goes untagged or is logged against no sentence or twice; no_claim=what the check decides
  test("logs every request a check makes against its sentence", async () => {
    const received: Received[] = [];
    const scripted = model(received);
    const watch = watchRequests([]);
    const { core } = await setUpWithDocuments(scripted, [AGREEMENT], {
      createChatModel: watch.chatModels(() => scripted),
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const asked = received.length;

    const result = await core.checkClaim({ claim: SALARY });

    expect(result.verdict).toBe("contradicted");
    const ofCheck = received.slice(asked);
    const requests = watch.take().get(SALARY) ?? [];
    // The Run cites and gives its verdict, on the search made for it: one request each, at least.
    const runs = ofCheck.filter((each) => each.run);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(requests).toHaveLength(ofCheck.length);
    expect(requests.filter((request) => request.kind === "check")).toHaveLength(runs.length);
    expect(new Set(ofCheck.map((each) => each.tag))).toEqual(new Set([SALARY]));
  });
});
