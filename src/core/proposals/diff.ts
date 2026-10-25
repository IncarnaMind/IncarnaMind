/**
 * What changed between two runs of words: the old text of a selection and
 * the model's new text, as tokens (see `splitWords`), compared with Myers'
 * diff and grouped into hunks a reader can review one at a time. The core
 * writes Proposals into the Mind's Yjs document, where there is no editor
 * document to compare, so it compares the words itself.
 */

/** A number with its sign and unit, "£1.2m", "41.8%", "3.1×", "2017.05", "12:04". */
const NUMBER = String.raw`\p{Sc}?\d+(?:[.,:/]\d+)*(?:\s?(?:%|‰|×|[kKmMbB]n?(?![\p{L}\p{N}])))?`;

/**
 * A number, date or range read as one word ("2017.05—2018.09", "pp. 3-5"), so
 * a change never cuts one: not inside a word ("Q3", "3rd").
 */
const UNIT = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${NUMBER}(?:\s?[—–~～-]\s?${NUMBER})?(?![\p{Script=Latin}\p{N}_])`,
  "gu",
);

/** Words as the language has them: Chinese and Japanese by their words, not by character. */
const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Text cut into tokens: a word, a number with its unit, a run of spaces, or a
 * mark of punctuation. Joined again, they are the text.
 */
export function splitWords(text: string): string[] {
  const tokens: string[] = [];
  const words = (part: string) => {
    for (const { segment } of WORDS.segment(part)) tokens.push(segment);
  };
  let at = 0;
  for (const unit of text.matchAll(UNIT)) {
    words(text.slice(at, unit.index));
    tokens.push(unit[0]);
    at = unit.index + unit[0].length;
  }
  words(text.slice(at));
  return tokens;
}

/** One step from the old tokens to the new: keep one, remove one, or add one. */
export type Step = "equal" | "delete" | "insert";

/**
 * The shortest way from `a` to `b` (Myers, 1986), as steps in order. Past
 * `maxCost` removals and additions it stops looking and replaces all of
 * `a` with all of `b`, which is what so different a text reads as anyway.
 */
export function diffSteps(a: readonly string[], b: readonly string[], maxCost = 4_000): Step[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = shortestPath(a.slice(start, endA), b.slice(start, endB), maxCost);
  return slideOffSpaces(
    [...Array<Step>(start).fill("equal"), ...middle, ...Array<Step>(a.length - endA).fill("equal")],
    a,
    b,
  );
}

const SPACE = /^\s+$/;

/**
 * A word removed or added with the space before it ("and[ really] regular")
 * reads better with the space after it ("and [really ]regular"): a run of
 * removals, or of additions, that starts with a space the token after it
 * repeats moves on by one, as far as it can.
 */
function slideOffSpaces(steps: Step[], a: readonly string[], b: readonly string[]): Step[] {
  let x = 0;
  let y = 0;
  for (let at = 0; at < steps.length; ) {
    const kind = steps[at] ?? "equal";
    if (kind === "equal") {
      at++;
      x++;
      y++;
      continue;
    }
    let end = at;
    while (steps[end] === kind) end++;
    const tokens = kind === "delete" ? a : b;
    let from = kind === "delete" ? x : y;
    let length = end - at;
    // Only a run on its own, with a kept token after it that it can move past.
    while (
      steps[end] === "equal" &&
      SPACE.test(tokens[from] ?? "") &&
      tokens[from] === tokens[from + length]
    ) {
      steps[at] = "equal";
      steps[end] = kind;
      at++;
      end++;
      from++;
      x++;
      y++;
      length = end - at;
    }
    if (kind === "delete") x += length;
    else y += length;
    at = end;
  }
  return steps;
}

function shortestPath(a: readonly string[], b: readonly string[], maxCost: number): Step[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return Array<Step>(m).fill("insert");
  if (m === 0) return Array<Step>(n).fill("delete");
  const max = Math.min(n + m, maxCost);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  /** The furthest x on each diagonal after each cost: only diagonals -d..d, to keep it small. */
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0));
      let x = down ? (v[k + 1 + offset] ?? 0) : (v[k - 1 + offset] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return backtrack(trace, n, m);
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return [...Array<Step>(n).fill("delete"), ...Array<Step>(m).fill("insert")];
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): Step[] {
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const before = trace[d - 1] as Int32Array;
    /** The furthest x on diagonal `k` after cost d - 1. */
    const at = (k: number) => before[k + d - 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      steps.push("equal");
      x--;
      y--;
    }
    steps.push(down ? "insert" : "delete");
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    steps.push("equal");
    x--;
    y--;
  }
  return steps.reverse();
}

/** A hunk: old tokens [oldFrom, oldTo) replaced by new tokens [newFrom, newTo); either may be empty. */
export interface Hunk {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
}

/**
 * The hunks of the steps, one per place that changed. A few tokens kept
 * between two changes join them into one (`joins`, given the old tokens'
 * indexes), so a sentence rewritten word by word reads as one change rather
 * than a change at every other word.
 */
export function hunksOf(steps: readonly Step[], joins: (from: number, to: number) => boolean) {
  const hunks: Hunk[] = [];
  let oldAt = 0;
  let newAt = 0;
  let current: Hunk | null = null;
  /** Where the tokens kept since the last change start. */
  let keptFrom: { old: number; new: number } | null = null;
  for (const step of steps) {
    if (step === "equal") {
      keptFrom ??= { old: oldAt, new: newAt };
      oldAt++;
      newAt++;
      continue;
    }
    if (current && keptFrom && joins(keptFrom.old, oldAt)) {
      // The tokens kept since are taken into this change: removed, and added again.
      current.oldTo = oldAt;
      current.newTo = newAt;
    } else if (!current || keptFrom) {
      current = { oldFrom: oldAt, oldTo: oldAt, newFrom: newAt, newTo: newAt };
      hunks.push(current);
    }
    keptFrom = null;
    if (step === "delete") current.oldTo = ++oldAt;
    else current.newTo = ++newAt;
  }
  return hunks;
}
