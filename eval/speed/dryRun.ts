/**
 * The model of a gate's free dry run (`INCARNAMIND_EVAL_SPEED_DRY=1`): nothing leaves this computer.
 * It checks by rote, so the whole gate runs end to end at no cost: a Run searches the sentence's
 * own words unless they were handed over, cites the line of its Passages that shares most of the
 * sentence's words, and calls it Supported only when that line holds the sentence word for word;
 * a first reply answers each part the same way. Its verdicts measure nothing but the plumbing.
 */
import {
  checkGenerate,
  listedSentences,
  SAME_DETAIL,
  sentenceOf,
} from "../../tests/helpers/checks";
import { shownPassages } from "../../tests/helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../../tests/helpers/models";

const bare = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, "");
const tokens = (text: string) =>
  new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/\p{Script=Han}|[\p{L}\p{N}]+/gu) ?? [],
  );

/** The line of `passages` that shares most of `claim`'s words, and whether it states it word for word. */
function bestLine(claim: string, passages: readonly { id: string; text: string }[]) {
  const own = tokens(claim);
  let best: { passage: string; line: string; share: number } | null = null;
  for (const passage of passages) {
    for (const line of passage.text.split(/(?<=[.。!?！？])\s*|\n/u)) {
      const words = tokens(line);
      const share =
        own.size === 0 ? 0 : [...own].filter((word) => words.has(word)).length / own.size;
      if (line.trim() && (!best || share > best.share))
        best = { passage: passage.id, line: line.trim(), share };
    }
  }
  return best && { ...best, states: bare(best.line).includes(bare(claim)) };
}

/** A Run's reply form for `claim`, from the line `bestLine` found. */
function replyFor(claim: string, found: ReturnType<typeof bestLine>, marker: number): string {
  const lines = [
    `Verdict: ${found?.states ? "supported" : "unsupported"}`,
    "Absence: no",
    "Scope: none, same",
    `Topic: ${found && found.share >= 0.5 ? "found" : "not found"}`,
    `Roles: ${claim} / ${found?.states ? claim : "none"}, same`,
    "Time: none / none, same",
    SAME_DETAIL,
    found?.states
      ? `Explanation: The Document says so. [^${marker}]`
      : "Explanation: The Documents don't say so.",
    `Evidence: [${found?.states ? marker : ""}]`,
  ];
  return lines.join("\n");
}

function runReply(call: ModelCall): ScriptedReply {
  const searches = call.results.filter((result) => result.tool === "search_documents");
  const claim = sentenceOf(call);
  if (searches.length === 0)
    return { calls: [{ tool: "search_documents", input: { query: claim } }] };
  const shown = searches.flatMap((search) => shownPassages(search.text));
  const found = bestLine(claim, [...shown, ...shownPassages(call.prompt)]);
  if (found?.states && !call.results.some((result) => result.tool === "cite")) {
    return {
      calls: [
        {
          tool: "cite",
          input: { citations: [{ marker: 1, passage: found.passage, quote: found.line }] },
        },
      ],
    };
  }
  return { text: replyFor(claim, found, 1) };
}

const PARTS = /<part number="(\d+)">([\s\S]*?)<\/part>/g;

export function dryRunModel() {
  const generate = checkGenerate({});
  return scriptedModel(runReply, {
    // An Answer's sentences, judged in batches, each supported by the quote it cites.
    judgesItsAnswers: true,
    generate: (call) => {
      if (call.question === "find-claims") {
        const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
          number,
          parts: [{ kind: "fact", text }],
        }));
        return { text: JSON.stringify({ sentences }) };
      }
      if (call.question === "first-reply") {
        const shown = shownPassages(call.prompt);
        const parts = [...call.prompt.matchAll(PARTS)].map((match) => match[2] ?? "");
        const found = parts.map((part) => bestLine(part, shown));
        return {
          text: JSON.stringify({
            parts: parts.map((part, at) => ({
              part: at + 1,
              reply: replyFor(part, found[at] ?? null, at + 1),
            })),
            citations: found.flatMap((each, at) =>
              each?.states ? [{ marker: at + 1, passage: each.passage, quote: each.line }] : [],
            ),
          }),
        };
      }
      return generate(call);
    },
  });
}
