import { describe, expect, test } from "vitest";
import { figuresOf } from "../../src/shared/numberWords";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { restatedAsQuoted, scriptedModel, unscripted } from "../helpers/models";

/** A check of `claim` whose model searches, cites each of `quotes` and calls it Supported on them. */
async function check(claim: string, quotes: readonly string[]) {
  const model = scriptedModel(
    (call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: quotes.join(" ") } }] };
      const shown = searches.flatMap((result) => shownPassages(result.text));
      if (!call.results.some((result) => result.tool === "cite")) {
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: quotes.map((quote, index) => ({
                  marker: index + 1,
                  passage:
                    shown.find((passage) => passage.text.includes(quote))?.id ?? shown[0]?.id,
                  quote,
                })),
              },
            },
          ],
        };
      }
      return {
        text: `Verdict: supported\nExplanation: The Documents establish this. [^1]\nEvidence: ${JSON.stringify(quotes.map((_, index) => index + 1))}`,
      };
    },
    {
      generate: (call) => {
        if (call.question === "restate") return { text: restatedAsQuoted(call) };
        if (call.question) return unscripted(call.question, call.system);
        return { text: JSON.stringify({ passage: null }) };
      },
    },
  );
  const { core } = await setUpWithDocuments(
    model,
    quotes.map((quote, index) => ({
      name: `source-${index + 1}.md`,
      contents: `# Source ${index + 1}\n\n${quote}\n`,
    })),
  );
  core.on("consent.requested", (event) => void core.respondToConsent(event.requestId, true));
  await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "synthetic-test-key",
    modelId: "claude-haiku-5-5",
  });
  return core.checkClaim({ claim });
}

describe("the quotes a sentence's check keeps", () => {
  test("a single literal fact retains every complementary checked quote", async () => {
    const claim = "Rook operated North and South branches.";
    const quotes = ["Rook operated the North branch.", "Rook operated the South branch."];
    const result = await check(claim, quotes);
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.evidence.map((citation) => citation.quote)).toEqual(quotes);
    expect(new Set(result.parts?.[0]?.evidence.map((citation) => citation.documentId)).size).toBe(
      2,
    );
  });
});

describe("number words", () => {
  // protects=numbers said one after another are each read with their own words (#1031); fails_when=one hundred twenty one hundred reads 100 and 2,100, or three hundred four thousand five hundred two thousand three reads 304,000 and 502,003; no_claim=which numbers a speaker meant where the words allow two readings.
  test.each<[string, number[]]>([
    ["one hundred twenty one hundred", [120, 100]],
    ["three hundred fifty four hundred", [350, 400]],
    ["two thousand five hundred three thousand", [2500, 3000]],
    ["three hundred four thousand five hundred two thousand three", [304500, 2003]],
    ["two thousand three hundred thousand", [2000, 300000]],
    ["twenty twenty five", [20, 25]],
    ["four five", [4, 5]],
    ["three hundred four thousand five hundred", [304500]],
  ])("the numbers of %s", (words, values) => {
    expect(figuresOf(words.split(" ")).map((figure) => figure.value)).toEqual(values);
  });

  // protects=a run of number words is read in one pass however long it is (#1031); fails_when=the reader calls itself on the rest of the words at every new number, and 10,000 numbers overflow the stack; no_claim=how long the reading takes.
  test("10,000 numbers in a row are read, and are not one number", () => {
    const run = "one hundred ".repeat(10_000).trim();
    expect(figuresOf(run.split(" "))).toHaveLength(10_000);
  });
});
