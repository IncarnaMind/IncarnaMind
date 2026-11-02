/**
 * Checks one Mind's sentences again and again, as Check this Mind does when
 * the User presses it on an unchanged Mind: the first time the model names the
 * claims and only the new sentences are checked ("changed"), every later time
 * all of them are ("all"). Each time, every sentence's result is read from its
 * mark, as the editor reads it, with how its card shows it. Any core with
 * Documents will do: the cases are the caller's.
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

export interface RepeatOptions {
  mind: string;
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

/** Makes the Mind, then checks it `repeats` times. */
export async function repeatChecks(core: Core, options: RepeatOptions): Promise<RepeatResult[]> {
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
  const all: RepeatResult[] = [];
  for (let repeat = 1; repeat <= options.repeats; repeat++) {
    const mode = repeat === 1 ? "changed" : "all";
    const requestId = `${mindId}-${repeat}`;
    if (repeat === 1) {
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
