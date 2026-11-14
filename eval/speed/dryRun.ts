/**
 * The models of a gate's free runs (`INCARNAMIND_EVAL_SPEED_DRY`): nothing leaves this computer.
 * Each checks by rote, so the whole gate runs end to end at no cost. A Run searches the sentence's
 * own words unless they were handed over, and cites the line of its Passages that shares most of
 * the sentence's words; a first reply answers each part the same way.
 * - `rote` (`DRY=1`) calls a sentence Supported only when that line holds it word for word, and a
 *   figure only when the line writes its number: its verdicts measure nothing but the plumbing.
 * - `yes` (`DRY=yes`) calls every sentence and every figure Supported from that line, whatever it
 *   says, so only the check's own guards (the quote found, the quote stating its line, figures,
 *   units and scales, names) stand between it and a Supported mark.
 */
import {
  checkGenerate,
  listedSentences,
  SAME_DETAIL,
  sentenceOf,
} from "../../tests/helpers/checks";
import { shownPassages } from "../../tests/helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../../tests/helpers/models";

export type DryModel = "rote" | "yes";

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

type Found = ReturnType<typeof bestLine>;

interface Requested {
  id: string;
  shown: string;
  ambiguous: boolean;
}

const FIGURES = /<figures(?: part="(\d+)")?>\n([\s\S]*?)\n<\/figures>/g;

/** The figures a request asks about, by the part they are given with (0 for a Run's own). */
function requestedIn(prompt: string): Map<number, Requested[]> {
  const found = new Map<number, Requested[]>();
  for (const match of prompt.matchAll(FIGURES)) {
    const value: unknown = JSON.parse(match[2] ?? "[]");
    if (!Array.isArray(value)) continue;
    found.set(
      Number(match[1] ?? 0),
      value.flatMap((figure: unknown) => {
        if (typeof figure !== "object" || figure === null) return [];
        const { id, shown, ambiguities } = figure as Record<string, unknown>;
        return typeof id === "string" && typeof shown === "string"
          ? [{ id, shown, ambiguous: Array.isArray(ambiguities) && ambiguities.length > 0 }]
          : [];
      }),
    );
  }
  return found;
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** A Figures line for `figures`, each bound to the cited line's number as `model` would. */
function figuresLine(figures: readonly Requested[], found: Found, marker: number, model: DryModel) {
  const numbers = found ? (found.line.match(NUMBER) ?? []) : [];
  const items = figures.map(({ id, shown, ambiguous }) => {
    const own = shown.match(NUMBER)?.[0];
    const number =
      numbers.find((each) => each === own) ?? (model === "yes" ? numbers[0] : undefined);
    const bound = number !== undefined && (model === "yes" || found?.states === true);
    return {
      id,
      verdict: bound ? "supported" : "unsupported",
      scope: "same",
      topic: bound ? "found" : "not found",
      roles: "same",
      measure: null,
      says: null,
      reading: ambiguous ? 1 : null,
      relation: "equals",
      source: bound ? { citation: marker, number } : null,
      calculation: null,
    };
  });
  return `Figures: ${JSON.stringify({ items, remainder: null })}`;
}

/** A Run's reply form for `claim`, from the line `bestLine` found. */
function replyFor(
  claim: string,
  found: Found,
  marker: number,
  model: DryModel,
  figures: readonly Requested[],
): string {
  const supported = found !== null && (model === "yes" || found.states);
  const lines = [
    `Verdict: ${supported ? "supported" : "unsupported"}`,
    "Absence: no",
    "Scope: none, same",
    `Topic: ${supported || (found && found.share >= 0.5) ? "found" : "not found"}`,
    `Roles: ${claim} / ${supported ? claim : "none"}, same`,
    "Time: none / none, same",
    SAME_DETAIL,
    supported
      ? `Explanation: The Document says so. [^${marker}]`
      : "Explanation: The Documents don't say so.",
    `Evidence: [${supported ? marker : ""}]`,
    ...(figures.length > 0 ? [figuresLine(figures, found, marker, model)] : []),
  ];
  return lines.join("\n");
}

const cites = (found: Found, model: DryModel) =>
  found !== null && (model === "yes" || found.states);

const runReply =
  (model: DryModel) =>
  (call: ModelCall): ScriptedReply => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    const claim = sentenceOf(call);
    if (searches.length === 0)
      return { calls: [{ tool: "search_documents", input: { query: claim } }] };
    const shown = searches.flatMap((search) => shownPassages(search.text));
    const found = bestLine(claim, [...shown, ...shownPassages(call.prompt)]);
    if (found && cites(found, model) && !call.results.some((result) => result.tool === "cite")) {
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: found.passage, quote: found.line }] },
          },
        ],
      };
    }
    return { text: replyFor(claim, found, 1, model, requestedIn(call.prompt).get(0) ?? []) };
  };

const PARTS = /<part number="(\d+)">([\s\S]*?)<\/part>/g;

export function dryRunModel(model: DryModel) {
  const generate = checkGenerate({});
  return scriptedModel(runReply(model), {
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
        const figures = requestedIn(call.prompt);
        const found = parts.map((part) => bestLine(part, shown));
        return {
          text: JSON.stringify({
            parts: parts.map((part, at) => ({
              part: at + 1,
              reply: replyFor(part, found[at] ?? null, at + 1, model, figures.get(at + 1) ?? []),
            })),
            citations: found.flatMap((each, at) =>
              each && cites(each, model)
                ? [{ marker: at + 1, passage: each.passage, quote: each.line }]
                : [],
            ),
          }),
        };
      }
      return generate(call);
    },
  });
}
