/**
 * The shared room of an Answer's sentence batches, replayed with no model on whole replies measured
 * with 8,000 tokens of room (#2962): for an Answer of so many sentences, each batch's room in equal
 * parts and fewest sentences first, and how many measured batches of its size that room would cut.
 *
 * The batches go out together until the next one's old room no longer fits beside them under the
 * Answer's $0.25, then wait for them to settle, as the check sends them. A batch out is set aside as
 * the meter reserves it, from the measured prompt; one settled counts what its size's median reply
 * cost. Sizes nobody measured are interpolated for what they set aside and spend, and cut nothing.
 */
import { equalShare } from "../../src/core/answers/checks/answerCheck";
import { costOf, reservationOf } from "../../src/core/cost/price";
import { catalogFacts } from "../../src/core/providers/catalog";
import { outputTokens } from "../../src/core/providers/outputLimits";

/** One measured batch: its sentences, the prompt and its cached part, and all it wrote. */
type Measured = readonly [sentences: number, input: number, cached: number, output: number];

/** Claude Opus 5.5 and Claude Fable 5, 2026-11-12 (#2962), the second held-out written set. */
const OPUS_5_5: readonly Measured[] = [
  [1, 1316, 0, 72],
  [1, 1312, 730, 362],
  [1, 1312, 730, 72],
  [1, 1308, 730, 78],
  [1, 1321, 730, 72],
  [1, 1307, 730, 72],
  [8, 1764, 730, 836],
  [8, 1790, 730, 1011],
  [8, 1753, 730, 1101],
  [1, 1301, 0, 70],
  [1, 1307, 737, 379],
  [1, 1307, 737, 72],
  [1, 1313, 737, 75],
  [1, 1301, 737, 69],
  [1, 1306, 737, 72],
  [8, 1777, 737, 939],
  [8, 1756, 737, 1056],
  [8, 1754, 737, 1090],
];
const FABLE_5: readonly Measured[] = [
  [1, 1314, 0, 111],
  [1, 1310, 730, 567],
  [1, 1310, 730, 81],
  [1, 1306, 730, 82],
  [1, 1319, 730, 119],
  [1, 1305, 730, 81],
  [8, 1762, 730, 1522],
  [8, 1788, 730, 1484],
  [8, 1751, 730, 2980],
  [1, 1299, 0, 104],
  [1, 1305, 737, 720],
  [1, 1305, 737, 113],
  [1, 1311, 737, 108],
  [1, 1299, 737, 145],
  [1, 1304, 737, 111],
  [8, 1775, 737, 662],
  [8, 1754, 737, 1506],
  [8, 1752, 737, 1856],
];
/** Claude Sonnet 5.5, 2026-11-10 (#2951), the same set and room. */
const SONNET_5_5: readonly Measured[] = [
  [1, 1316, 0, 79],
  [1, 1312, 730, 460],
  [1, 1312, 730, 73],
  [1, 1308, 730, 78],
  [1, 1321, 730, 77],
  [1, 1307, 730, 72],
  [2, 1380, 730, 732],
  [2, 1372, 730, 134],
  [2, 1380, 730, 130],
  [2, 1376, 730, 138],
  [2, 1396, 730, 202],
  [2, 1395, 730, 173],
  [3, 1444, 730, 607],
  [3, 1440, 730, 198],
  [3, 1456, 730, 234],
  [3, 1463, 730, 251],
  [3, 1436, 730, 223],
  [3, 1451, 730, 271],
  [8, 1764, 730, 1100],
  [8, 1790, 730, 620],
  [8, 1753, 730, 616],
  [8, 1833, 730, 975],
  [1, 1312, 730, 476],
  [8, 1780, 730, 573],
  [8, 1786, 730, 617],
  [1, 1301, 0, 75],
  [1, 1307, 737, 556],
  [1, 1307, 737, 78],
  [1, 1313, 737, 88],
  [1, 1301, 737, 82],
  [1, 1306, 737, 76],
  [2, 1368, 737, 500],
  [2, 1380, 737, 155],
  [2, 1367, 737, 154],
  [2, 1382, 737, 165],
  [2, 1382, 737, 198],
  [2, 1379, 737, 188],
  [3, 1435, 737, 601],
  [3, 1440, 737, 209],
  [3, 1463, 737, 245],
  [3, 1440, 737, 272],
  [3, 1412, 737, 265],
  [3, 1439, 737, 282],
  [8, 1777, 737, 1096],
  [8, 1756, 737, 626],
  [8, 1754, 737, 646],
  [8, 1855, 737, 580],
  [2, 1368, 737, 486],
  [8, 1791, 737, 618],
  [8, 1750, 737, 643],
];

export const REPLAYED = [
  { name: "Claude Fable 5", modelId: "claude-fable-5", measured: FABLE_5, own: true },
  // Never measured: Opus 5.5's replies, at Opus 5's price.
  { name: "Claude Opus 5", modelId: "claude-opus-5", measured: OPUS_5_5, own: false },
  { name: "Claude Opus 5.5", modelId: "claude-opus-5-5", measured: OPUS_5_5, own: true },
  { name: "Claude Sonnet 5.5", modelId: "claude-sonnet-5-5", measured: SONNET_5_5, own: true },
] as const;

export const ANSWER_SENTENCES = [3, 8, 9, 10, 12, 16, 20, 24, 40, 48] as const;

export type Order = "equal" | "fewest";

const LIMIT = 0.25;
const AT = new Date("2026-11-12T12:00:00Z");

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** A measured quantity of a batch of `size`, its median, straight between the sizes measured. */
function bySize(measured: readonly Measured[], size: number, pick: (row: Measured) => number) {
  const sizes = [...new Set(measured.map(([n]) => n))].sort((a, b) => a - b);
  const at = (n: number) => median(measured.filter(([each]) => each === n).map(pick));
  const below = sizes.filter((n) => n <= size).at(-1) ?? sizes[0] ?? size;
  const above = sizes.find((n) => n >= size) ?? below;
  if (below === above) return at(below);
  return at(below) + ((at(above) - at(below)) * (size - below)) / (above - below);
}

/** The Answer's batches: eight sentences each, the rest last. */
export const batchSizes = (sentences: number) => [
  ...Array<number>(Math.floor(sentences / 8)).fill(8),
  ...(sentences % 8 ? [sentences % 8] : []),
];

export interface ReplayedBatch {
  sentences: number;
  /** The room it is sent with; null when the Answer's limit leaves it unsent. */
  room: number | null;
  /** Measured batches of its size its room would cut, of those measured; null when none was. */
  cut: { of: number; cut: number } | null;
}

export function replay(
  model: (typeof REPLAYED)[number],
  sentences: number,
  order: Order,
): ReplayedBatch[] {
  const price = catalogFacts("anthropic", model.modelId)?.price;
  if (!price) throw new Error(`No price for ${model.modelId}.`);
  const prompt = (size: number) => bySize(model.measured, size, ([, input]) => input);
  const most = (size: number, room: number) =>
    reservationOf(
      { promptTokens: prompt(size), outputTokens: room, cacheWrites: true, kind: "anthropic" },
      price,
      AT,
    );
  const spends = (size: number) =>
    costOf(
      {
        inputTokens: prompt(size),
        cachedInputTokens: bySize(model.measured, size, ([, , cached]) => cached),
        outputTokens: bySize(model.measured, size, ([, , , output]) => output),
      },
      price,
      AT,
      { cacheWrites: true },
    );
  const records = (size: number) => outputTokens("sentence-batch-records", size);
  const larger = (size: number) => outputTokens("sentence-batch", size);
  const perToken = (size: number) => most(size, 1) - most(size, 0);

  const sizes = batchSizes(sentences);
  let spent = 0;
  let open: { size: number; most: number }[] = [];
  const sent: ReplayedBatch[] = [];
  for (const [at, size] of sizes.entries()) {
    const out = () => open.reduce((sum, each) => sum + each.most, 0);
    if (spent + out() + most(size, records(size)) > LIMIT && open.length > 0) {
      spent += open.reduce((sum, each) => sum + spends(each.size), 0);
      open = [];
    }
    if (spent + out() + most(size, records(size)) > LIMIT) {
      for (const left of sizes.slice(at)) sent.push({ sentences: left, room: null, cut: null });
      break;
    }
    const unsent = sizes.slice(at);
    const spare =
      (LIMIT - spent - out() - unsent.reduce((sum, each) => sum + most(each, records(each)), 0)) /
      perToken(size);
    const wanted = unsent.map((each) => larger(each) - records(each));
    const extra =
      order === "equal"
        ? Math.min(wanted[0] ?? 0, Math.floor(equalShare(spare, wanted)))
        : fewestFirst(spare, unsent, wanted);
    const room = records(size) + extra;
    open.push({ size, most: most(size, room) });
    const measured = model.measured.filter(([n]) => n === size);
    sent.push({
      sentences: size,
      room,
      cut: measured.length
        ? { of: measured.length, cut: measured.filter(([, , , output]) => output >= room).length }
        : null,
    });
  }
  return sent;
}

/** The first of `unsent`'s extra when the fewest sentences take what they want first. */
function fewestFirst(spare: number, unsent: readonly number[], wanted: readonly number[]) {
  const ranked = unsent
    .map((size, at) => ({ size, at, want: wanted[at] ?? 0 }))
    .sort((a, b) => a.size - b.size || a.at - b.at);
  let left = Math.max(0, spare);
  for (const each of ranked) {
    const take = Math.floor(Math.min(each.want, left));
    if (each.at === 0) return take;
    left -= take;
  }
  return 0;
}

/** Sentences cut and left unsent over an Answer, counted where its batches' sizes were measured. */
export function cutSentences(batches: readonly ReplayedBatch[]) {
  let cut = 0;
  let unsent = 0;
  for (const batch of batches) {
    if (batch.room === null) unsent += batch.sentences;
    else if (batch.cut) cut += (batch.sentences * batch.cut.cut) / batch.cut.of;
  }
  return { cut, unsent };
}

const rooms = (batches: readonly ReplayedBatch[]) =>
  batches
    .map((batch) =>
      batch.room === null
        ? `${batch.sentences}: not sent`
        : `${batch.sentences}: ${batch.room.toLocaleString("en")}${
            batch.cut ? ` (cuts ${batch.cut.cut} of ${batch.cut.of})` : ""
          }`,
    )
    .join(" · ");

/** The replay as the pull request shows it: a row for each model and Answer. */
export function replayTable(): string {
  const lines = [
    "| Model | Answer | Equal parts: each batch's room (measured batches of its size it cuts) | Fewest first | Sentences cut: equal / fewest first | Not sent |",
    "|---|---|---|---|---|---|",
  ];
  for (const model of REPLAYED) {
    for (const sentences of ANSWER_SENTENCES) {
      const equal = replay(model, sentences, "equal");
      const fewest = replay(model, sentences, "fewest");
      const a = cutSentences(equal);
      const b = cutSentences(fewest);
      lines.push(
        `| ${model.name} | ${sentences} | ${rooms(equal)} | ${rooms(fewest)} | ${a.cut.toFixed(1)} / ${b.cut.toFixed(1)} | ${a.unsent} / ${b.unsent} |`,
      );
    }
  }
  return lines.join("\n");
}
