/**
 * Checks one Mind's sentences again and again. A User's check is one sort of the Note's sentences
 * (the model names the claims) and the verdicts that follow, so a run whose bar is about a mark or a
 * verdict gives every check a Note of its own, sorted afresh; a run whose bar is about speed or
 * cost may check one Note again and again, as Check this Mind does when the User presses it on an
 * unchanged Mind: the first time the model names the claims and only the new sentences are checked
 * ("changed"), every later time all of them are ("all") on the first one's sort (#2964). Each time,
 * every sentence's result is read from its mark, as the editor reads it, with how its card shows it.
 * Any core with Documents will do: the cases are the caller's.
 */
import * as Y from "yjs";
import type { ChatModelChoice, ClaimCheckAttributes, Core, SearchScope } from "../../src/core";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { coveredPart, saysNotFound } from "../../src/shared/claimChecks";
import { setMindScope } from "../../src/shared/mindScope";
import { connectToMind } from "../../tests/helpers/mindClient";
import { note, readMind, writeMind } from "../../tests/helpers/minds";

/**
 * How a sentence's check shows on its card: "partly" names what the Documents
 * support with a quote, "differs" quotes a line that says something
 * different, "absent" says where the check looked and didn't find it, and
 * "unsupported" is the card headed Unsupported with nothing to quote.
 */
export type Outcome =
  | "supported"
  | "contradicted"
  | "partly"
  | "differs"
  | "absent"
  | "unsupported"
  | "not-checked"
  | "no-mark";

export interface RepeatResult {
  repeat: number;
  /** The sort this check's verdicts rest on, by number: its own for fresh sorts, else the first. */
  sort: number;
  sentence: string;
  outcome: Outcome;
  /** The check's own words: what the Document says, or why it is unsupported. */
  says: string | null;
  covered: string | null;
  uncovered: string | null;
  quote: string | null;
  /** Why it wasn't checked, with the provider's message. */
  failure: string | null;
}

export function outcomeOf(check: ClaimCheckAttributes | undefined): Outcome {
  if (!check) return "no-mark";
  if (check.state === "supported" || check.state === "contradicted") return check.state;
  if (check.state !== "unsupported") return "not-checked";
  if (check.evidence) return "differs";
  if (coveredPart(check.unsupported)) return "partly";
  // The eval's sentences carry no Citations, and saysNotFound decides the Not found card for the app.
  return saysNotFound({ state: "unsupported" }, check, 0) ? "absent" : "unsupported";
}

/** One read of the Mind's marks, from the core's own copy of it. */
export async function marksOf(core: Core, mindId: string) {
  const { state } = await core.openMind(mindId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return claimSpans(readMind({ blocks: doc.getXmlFragment(MIND_CONTENT_FIELD) })).map((span) => ({
    sentence: span.sentence.text.trim(),
    check: span.check,
  }));
}

/**
 * What a run's bar is about: whether a sentence gets a mark or which verdict it gets ("verdict"),
 * or its time or cost ("speed").
 */
export type BarKind = "verdict" | "speed";

/** How a run's checks sort the sentences: each in a Note of its own, or all on the first's sort. */
export type Sorts = "fresh" | "reused";

export const BAR_KINDS: readonly BarKind[] = ["verdict", "speed"];
export const SORTS: readonly Sorts[] = ["fresh", "reused"];

/** The bar a run names (INCARNAMIND_EVAL_REPEATS_BAR): a mark or a verdict unless it says speed. */
export function barOf(value: string | undefined): BarKind {
  const named = value?.trim() || "verdict";
  const bar = BAR_KINDS.find((each) => each === named);
  if (!bar) throw new Error(`INCARNAMIND_EVAL_REPEATS_BAR is "${named}": use verdict or speed.`);
  return bar;
}

/** The sorts a run asks for (INCARNAMIND_EVAL_REPEATS_SORTS), if any. */
export function sortsAsked(value: string | undefined): Sorts | undefined {
  const named = value?.trim();
  if (!named) return undefined;
  const sorts = SORTS.find((each) => each === named);
  if (!sorts) throw new Error(`INCARNAMIND_EVAL_REPEATS_SORTS is "${named}": use fresh or reused.`);
  return sorts;
}

/**
 * The sorts a run makes for its bar: fresh for a verdict bar, reused for a speed bar unless asked
 * otherwise. A verdict bar over a reused sort throws, so it is refused before any request is sent.
 */
export function sortsOf(bar: BarKind, asked?: Sorts): Sorts {
  if (bar === "verdict" && asked === "reused")
    throw new Error(
      "A bar about a mark or a verdict can't reuse one sort: every check of the run would rest on " +
        "the same sort of the sentences, so its checks would be one sample, not one each (#2964). " +
        "Run it with a fresh sort for each check (INCARNAMIND_EVAL_REPEATS_SORTS=fresh, or unset), " +
        "or, for a bar about time or cost, set INCARNAMIND_EVAL_REPEATS_BAR=speed.",
    );
  return asked ?? (bar === "verdict" ? "fresh" : "reused");
}

export interface RepeatOptions {
  mind: string;
  /** What the run's bar is about, which decides its sorts. */
  bar: BarKind;
  /** Asked for explicitly; refused when it is "reused" under a verdict bar. */
  sorts?: Sorts;
  folderId?: string | null;
  /** The Search scope the User set for the Mind, as its composer keeps it; none: its own. */
  scope?: SearchScope;
  sentences: readonly string[];
  /** The sentences are one paragraph, joined by this; absent: a paragraph each. */
  inOneParagraph?: string;
  repeats: number;
  model: ChatModelChoice;
  /** Called after each repeat with its results; false stops the run there (a spending limit). */
  onRepeat(results: readonly RepeatResult[]): boolean | Promise<boolean>;
}

/** Makes a Mind of the sentences, in the Folder and with the Search scope asked for. */
async function mindOf(
  core: Core,
  options: Pick<RepeatOptions, "mind" | "folderId" | "scope" | "sentences" | "inOneParagraph">,
): Promise<string> {
  const { id: mindId } = await core.createMind({
    title: options.mind,
    folderId: options.folderId ?? null,
  });
  const client = await connectToMind(core, mindId);
  writeMind(
    client,
    options.inOneParagraph === undefined
      ? options.sentences.map((sentence) => note(sentence))
      : [note(options.sentences.join(options.inOneParagraph))],
  );
  if (options.scope) setMindScope(client.doc, options.scope);
  await client.settled();
  return mindId;
}

/** Checks the sentences `repeats` times, each check on a Mind of its own or all on one, as the bar's sorts say. */
export async function repeatChecks(core: Core, options: RepeatOptions): Promise<RepeatResult[]> {
  const sorts = sortsOf(options.bar, options.sorts);
  const all: RepeatResult[] = [];
  let mindId = "";
  for (let repeat = 1; repeat <= options.repeats; repeat++) {
    const sorted = repeat === 1 || sorts === "fresh";
    if (sorted) mindId = await mindOf(core, options);
    const mode = sorted ? "changed" : "all";
    const requestId = `${mindId}-${repeat}`;
    if (sorted) {
      await core.findMindClaims({
        requestId: `${requestId}-claims`,
        mindId,
        mode,
        model: options.model,
      });
    }
    await core.checkMind({ requestId, mindId, mode, model: options.model });
    const marks = await marksOf(core, mindId);
    const results = options.sentences.map((sentence): RepeatResult => {
      const check = marks.find((each) => each.sentence === sentence)?.check;
      const covers = coveredPart(check?.unsupported ?? null);
      return {
        repeat,
        sort: sorts === "fresh" ? repeat : 1,
        sentence,
        outcome: outcomeOf(check),
        says: check?.says ?? check?.unsupported?.reason ?? null,
        covered: check?.unsupported?.covered ?? null,
        uncovered: check?.unsupported?.uncovered ?? null,
        quote: check?.evidence?.quote ?? covers?.quote ?? null,
        failure:
          check?.state === "not-checked"
            ? [check.reason, check.detail].filter(Boolean).join(": ")
            : null,
      };
    });
    all.push(...results);
    if (!(await options.onRepeat(results))) break;
  }
  return all;
}
