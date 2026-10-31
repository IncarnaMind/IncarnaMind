/**
 * The evaluation's request log ties each request a check makes to the sentence
 * it is for, whether the check is of the whole sentence or of one of its parts
 * (#2256): every request the scripted model receives is logged once, against
 * that sentence, with the part it checks.
 */
import { describe, expect, test } from "vitest";
import { watchRequests } from "../../eval/repeats/requests";
import { checkNow } from "../../src/core/answers/checks/checkedText";
import { setUpWithDocuments } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";

const AGREEMENT = {
  name: "Agreement.md",
  contents: "# Agreement\n\nThe salary is 60,000 per year, paid monthly in arrears.\n",
};
const SALARY = "The salary is 65,000 per year, paid monthly in arrears.";
const PARTS = [
  { kind: "fact", text: "The salary is 65,000 per year" },
  { kind: "fact", text: "paid monthly in arrears" },
];

/** A request the model received: whether it is the sort or a check's Run, and the sentence it named. */
type Received = { kind: "sort" | "run" | "other"; tag: string | null };

const kindOf = (system: string): Received["kind"] =>
  system.startsWith("You sort the sentences")
    ? "sort"
    : system.startsWith("You check one sentence")
      ? "run"
      : "other";

/** A model that names the sentence's two parts when it sorts it, and finds each contradicted with no quote recorded. */
function model(received: Received[]) {
  const see = (system: string) =>
    received.push({ kind: kindOf(system), tag: checkNow()?.sentence ?? null });
  return scriptedModel(
    (call) => {
      see(call.system);
      if (!call.results.some((result) => result.tool === "search_documents"))
        return { calls: [{ tool: "search_documents", input: { query: "salary" } }] };
      return {
        text: [
          "Verdict: contradicted",
          "Scope: none, same",
          "Topic: found",
          "Roles: none, same",
          "Calculation: none",
          "",
          "The agreement says 60,000, not 65,000.",
        ].join("\n"),
      };
    },
    {
      generate: (call) => {
        see(call.system);
        if (call.system.startsWith("You sort the sentences"))
          return { text: JSON.stringify({ sentences: [{ number: 1, parts: PARTS }] }) };
        if (call.system.startsWith("Compare a sentence")) return { text: "conflict" };
        return {
          text: JSON.stringify({
            passage: "P1",
            location: "§ Agreement",
            quote: "The salary is 60,000 per year",
          }),
        };
      },
    },
  );
}

describe("The evaluation's request log", () => {
  test("logs every request a check of a two-part sentence makes against that sentence", async () => {
    const received: Received[] = [];
    const scripted = model(received);
    const watch = watchRequests([SALARY]);
    const { core } = await setUpWithDocuments(scripted, [AGREEMENT], {
      createChatModel: watch.chatModels(() => scripted),
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const asked = received.length;

    const result = await core.checkClaim({ claim: SALARY });

    expect(result.verdict).toBe("contradicted");
    const ofCheck = received.slice(asked);
    const requests = watch.take().get(SALARY) ?? [];
    // Every request the model received is the sentence's, once: the whole sentence's
    // Run and sort, then each part's Run, its evidence and its two judgements.
    expect(ofCheck.length).toBeGreaterThan(6);
    expect(requests).toHaveLength(ofCheck.length);
    expect(new Set(requests.map((request) => request.kind))).toEqual(
      new Set(["check", "claims", "confirm", "evidence", "strict"]),
    );
    // A part's requests name the part, and the whole sentence's own name none.
    expect(new Set(requests.map((request) => request.part))).toEqual(
      new Set([null, ...PARTS.map((part) => part.text)]),
    );
    const whole = requests.filter((request) => request.part === null);
    expect(whole.map((request) => request.kind)).toEqual(
      expect.arrayContaining(["check", "claims"]),
    );
    // The first Run's requests name the sentence: the claim is a whole sentence, so its
    // words alone would find it.
    const runs = ofCheck.filter((each) => each.kind === "run");
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map((each) => each.tag)).toEqual(runs.map(() => SALARY));
    // The sort names it too, though its words alone are ones no watched sentence holds.
    const sorts = ofCheck.filter((each) => each.kind === "sort");
    expect(sorts).toHaveLength(1);
    expect(sorts[0]?.tag).toBe(SALARY);
    // And every other request of the check, the judgements and the evidence alike.
    expect(new Set(ofCheck.map((each) => each.tag))).toEqual(new Set([SALARY]));
  });
});
