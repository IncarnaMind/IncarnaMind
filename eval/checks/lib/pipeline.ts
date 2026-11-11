/**
 * The pipeline the checks evaluation runs end to end (#86): claims extracted
 * from a received document, then, for each claim or each of the User's
 * sentences in Find support, a search of the Folder through the core's
 * `searchEvidence` (which leaves out the document being checked, #80) and a
 * check against the Passages it found.
 *
 * The check is the app's claim-check function (#96, `checkClaim`), as Find
 * support and verify run it; extraction is still a baseline of one model call
 * (`baselinePipeline`), until verify's claim extraction (#97) can be called
 * on its own, and the bars gate then.
 */
import type {
  CheckedDocument,
  Citation,
  Core,
  PassageSearchResult,
  SearchScope,
} from "../../../src/core";
import type { Generate } from "../../lib/rewrites";
import type { RequestWatch } from "../../repeats/requests";
import { judgeRecord } from "./judge";
import type { CheckOutcome, FoundEvidence, Verdict } from "./scoring";

export interface ClaimDraft {
  text: string;
  source: string;
}

export interface Extraction {
  claims: ClaimDraft[];
  /** Why no claims could be read from the model's reply; null when they were. */
  failure: string | null;
}

/** What the pipeline's model calls used, as the provider reported it. */
export interface PipelineUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ChecksPipeline {
  /** The claims in a received document's text, as the app extracts the text. */
  extractClaims(documentText: string): Promise<Extraction>;
  /** A sentence checked against the Folder; `checked` is the document it comes from, never evidence. */
  check(sentence: string, checked?: CheckedDocument): Promise<CheckOutcome>;
  usage(): PipelineUsage;
}

export interface PipelineOptions {
  core: Pick<Core, "searchEvidence">;
  generate: Generate;
  /** The Folder the checks search. */
  scope: SearchScope;
  /** A Document's name in the labels, from what the search gives. */
  nameOf(passage: PassageSearchResult): string;
}

const VERDICTS: readonly Verdict[] = ["supported", "unsupported", "contradicted"];

function extractionPrompt(documentText: string): string {
  return [
    "Below is a document someone else wrote. List every claim in it that could be checked against other documents: each fact, figure, date, name or outcome it states, one claim per item. Leave out greetings, opinions, thanks and requests.",
    "Write each claim so that it stands on its own, in the document's language, and give the sentence it comes from, copied exactly from the document.",
    'Reply with JSON only, in this shape: {"claims": [{"claim": "...", "source": "..."}]}',
    "",
    "Document:",
    documentText,
  ].join("\n");
}

function checkPrompt(sentence: string, passages: readonly PassageSearchResult[]): string {
  const listed = passages.map(
    (passage, index) => `[P${index + 1}] ${passage.documentName}\n${passage.text.trim()}`,
  );
  return [
    "Check a sentence against passages from the user's documents.",
    'Answer "supported" when a passage says everything the sentence says; "contradicted" when a passage says something that conflicts with it, such as another figure, date, party or outcome; "unsupported" when no passage says it either way.',
    'Reply with JSON only, in this shape: {"verdict": "supported", "passage": "P1", "quote": "..."}, where "quote" is the passage\'s words that decide it, copied exactly. Use null for "passage" and "quote" when the verdict is "unsupported".',
    "",
    `Sentence: ${sentence}`,
    "",
    "Passages:",
    listed.join("\n\n"),
  ].join("\n");
}

/** The JSON object in a model's reply, fenced or not; null when there is none. */
function parseReply(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const notChecked = (reason: string): CheckOutcome => ({
  verdict: "not-checked",
  reason,
  evidence: null,
});

/** The baseline pipeline: one call to extract a document's claims, one to check each sentence. */
export function baselinePipeline(options: PipelineOptions): ChecksPipeline {
  const { core, scope, nameOf } = options;
  const usage: PipelineUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const generate: Generate = async (prompt) => {
    usage.calls++;
    const reply = await options.generate(prompt);
    usage.inputTokens += reply.inputTokens ?? 0;
    usage.outputTokens += reply.outputTokens ?? 0;
    return reply;
  };

  return {
    usage: () => ({ ...usage }),

    async extractClaims(documentText) {
      let text: string;
      try {
        ({ text } = await generate(extractionPrompt(documentText)));
      } catch (error) {
        return { claims: [], failure: `The model failed: ${messageOf(error)}` };
      }
      const claims = parseReply(text)?.claims;
      if (!Array.isArray(claims)) {
        return { claims: [], failure: "The model's reply held no list of claims." };
      }
      return {
        claims: claims.flatMap((each: unknown) => {
          const { claim, source } = (each ?? {}) as Record<string, unknown>;
          if (typeof claim !== "string" || !claim.trim()) return [];
          return [{ text: claim.trim(), source: typeof source === "string" ? source.trim() : "" }];
        }),
        failure: null,
      };
    },

    async check(sentence, checked) {
      const { passages } = await core.searchEvidence(sentence, {
        scope,
        ...(checked && { checked }),
      });
      if (passages.length === 0) return { verdict: "unsupported", evidence: null };
      let text: string;
      try {
        ({ text } = await generate(checkPrompt(sentence, passages)));
      } catch (error) {
        return notChecked(`The model failed: ${messageOf(error)}`);
      }
      if (!text.trim()) return notChecked("The model's reply was empty.");
      const reply = parseReply(text);
      const verdict = VERDICTS.find((each) => each === reply?.verdict);
      if (!reply || !verdict) return notChecked("The model's reply held no verdict.");
      const index = typeof reply.passage === "string" ? Number(/\d+/.exec(reply.passage)?.[0]) : 0;
      const passage = verdict === "unsupported" ? undefined : passages[index - 1];
      const evidence: FoundEvidence | null = passage
        ? {
            document: nameOf(passage),
            units:
              passage.pageFrom !== null && passage.pageTo !== null
                ? [passage.pageFrom, passage.pageTo]
                : null,
            quote: typeof reply.quote === "string" ? reply.quote : "",
          }
        : null;
      return { verdict, evidence };
    },
  };
}

export interface CorePipelineOptions extends Omit<PipelineOptions, "core"> {
  core: Pick<Core, "searchEvidence" | "checkClaim">;
  /** A Document's name in the labels, from a Citation of it. */
  citedName(citation: Citation): string;
  /**
   * Watches the core's chat model (`watchRequests`), so each outcome keeps what the judge said
   * (#2910). The core must have been given its `chatModels`.
   */
  watch?: Pick<RequestWatch, "take">;
}

/** The baseline's extraction, and the app's claim check (`checkClaim`) for each sentence or claim. */
export function corePipeline(options: CorePipelineOptions): ChecksPipeline {
  const { core, scope, citedName, watch } = options;
  const baseline = baselinePipeline(options);

  async function checkClaim(sentence: string, checked?: CheckedDocument): Promise<CheckOutcome> {
    let result: Awaited<ReturnType<Core["checkClaim"]>>;
    try {
      result = await core.checkClaim({ claim: sentence, scope, ...(checked && { checked }) });
    } catch (error) {
      return notChecked(`The check failed: ${messageOf(error)}`);
    }
    if (result.verdict === "not-checked") {
      return {
        ...notChecked(`${result.reason}${result.detail ? `: ${result.detail}` : ""}`),
        code: result.reason,
      };
    }
    const { evidence } = result;
    return {
      verdict: result.verdict,
      evidence: evidence
        ? {
            document: citedName(evidence),
            units:
              evidence.pageFrom !== null && evidence.pageTo !== null
                ? [evidence.pageFrom, evidence.pageTo]
                : null,
            quote: evidence.quote,
          }
        : null,
    };
  }

  return {
    usage: baseline.usage,
    extractClaims: baseline.extractClaims,

    async check(sentence, checked) {
      const outcome = await checkClaim(sentence, checked);
      return watch ? { ...outcome, judge: judgeRecord(watch.take().get(sentence) ?? []) } : outcome;
    },
  };
}
