/**
 * The check of the changes a reply claims (#2037) starts while the reply's text beside `cite` is
 * judged for the model's working notes (#2371), instead of after it (#1624): the turn then ends
 * without waiting on the two in a row. Its verdict is only ever about the reply that stands: one
 * taken back changes the reply, and the check runs again on what is left. A claimed change no call
 * made is still caught. Through the core's public interface, with scripted models.
 */
import { describe, expect, test } from "vitest";
import type { CoreAdapters } from "../../src/core";
import { CLAIM_CHECK_INSTRUCTIONS } from "../../src/core/answers/claimedChanges";
import { WORKING_TEXT_INSTRUCTIONS } from "../../src/core/answers/workingText";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import {
  claimCheckReply,
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../helpers/models";

const SPRING = "Spring tides happen at new moon and at full moon.";
const TIDES_MD = ["# Tides", "", SPRING].join("\n");
const ANSWER = "Spring tides come at new and full moon[^1].";
const CLAIM = "I've added a Summary section to “Tides”.";
const ASKED_AGAIN = "but no Tool did that";

const asked = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

/**
 * A model that searches, then writes the Answer and a line claiming a change beside `cite`; asked
 * again, it writes the Answer alone. The working-notes judge gives `verdict` for that line, once
 * the change-claim check has been asked or a second has passed, and says which came first.
 */
function claimingBesideCite(verdict: "answer" | "working") {
  const seen = {
    claimChecks: [] as string[],
    beside: null as boolean | null,
    notes: [] as string[],
  };
  let claimAsked: () => void = () => undefined;
  const claimStarted = new Promise<void>((resolve) => {
    claimAsked = resolve;
  });
  const model = scriptedModel(
    (call: ModelCall): ScriptedReply => {
      seen.notes.push(asked(call));
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) return { calls: [{ tool: "search_documents", input: { query: "spring" } }] };
      if (asked(call).includes(ASKED_AGAIN))
        return { text: "Spring tides come at new and full moon." };
      const passage = shownPassages(searched.text)[0]?.id ?? "P1";
      return {
        text: `${ANSWER}\n\n${CLAIM}`,
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
      };
    },
    {
      generate: (call: GenerateCall): GeneratedReply => {
        if (call.system === CLAIM_CHECK_INSTRUCTIONS) {
          seen.claimChecks.push(call.prompt);
          claimAsked();
          return claimCheckReply(call, [{ sentence: CLAIM, kind: "added" }]);
        }
        if (call.system !== WORKING_TEXT_INSTRUCTIONS) return { text: "" };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), 1000);
        });
        const until = Promise.race([claimStarted.then(() => "beside" as const), waited]).then(
          (first) => {
            clearTimeout(timer);
            seen.beside = first === "beside";
          },
        );
        return { text: JSON.stringify({ parts: [verdict] }), until };
      },
    },
  );
  return { model, seen };
}

const writingFirst = (early?: boolean): Partial<CoreAdapters> => ({
  answerPaths: {
    writesThenCites: () => true,
    ...(early !== undefined && { checksClaimsEarly: () => early }),
  },
});

describe("The change-claim check beside the working-notes judgement (#1624)", {
  timeout: 30_000,
}, () => {
  // protects=a reply written beside cite has its claimed change checked while its text is judged for working notes, and a change no call made is still caught and asked about once more; fails_when=the check waits for the judgement, or the unmade claim stands without the ask; no_claim=how long either takes on a real model.
  test("starts while the text is judged, and still catches a change no call made", async () => {
    const { model, seen } = claimingBesideCite("answer");
    const { core, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      writingFirst(),
    );

    const answer = await askAssistant(core, { text: "When are spring tides?", mindId: mind.id });

    expect(seen.beside).toBe(true);
    expect(seen.claimChecks[0]).toContain(CLAIM);
    expect(seen.notes.some((note) => note.includes(ASKED_AGAIN))).toBe(true);
    expect(answer.text).not.toContain("I've added");
  });

  // protects=when the judgement takes the claiming line back as working, the reply that stands is checked again, so a verdict about text the User never sees is never used; fails_when=the early verdict is reused for the shorter reply, or the model is asked again about a line it no longer shows; no_claim=none beyond protects.
  test("checks again when a line is taken back as working, and uses only that verdict", async () => {
    const { model, seen } = claimingBesideCite("working");
    const { core, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      writingFirst(),
    );

    const answer = await askAssistant(core, { text: "When are spring tides?", mindId: mind.id });

    expect(seen.claimChecks).toHaveLength(2);
    expect(seen.claimChecks[0]).toContain(CLAIM);
    expect(seen.claimChecks[1]).not.toContain(CLAIM);
    expect(seen.notes.some((note) => note.includes(ASKED_AGAIN))).toBe(false);
    expect(answer.text).not.toContain("I've added");
  });

  // protects=the switch a paired run compares by: turned off, the check waits for the judgement, as before; fails_when=the switch has no effect; no_claim=that waiting is ever better.
  test("turned off, the check waits for the judgement, as before", async () => {
    const { model, seen } = claimingBesideCite("answer");
    const { core, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      writingFirst(false),
    );

    await askAssistant(core, { text: "When are spring tides?", mindId: mind.id });

    expect(seen.beside).toBe(false);
    expect(seen.notes.some((note) => note.includes(ASKED_AGAIN))).toBe(true);
  });
});
