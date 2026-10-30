import { readPartPlans } from "../../../shared/claimParts";
import { readClaimFacetPeriod } from "../../../shared/dates";
import type { ClaimFacetPeriod, ClaimPartPlan } from "../../api";
import { isRecord } from "../../errors";
import { type ReadVerdict, readVerdict } from "./prompt";
import { sourceNameIn } from "./sourceAttribution";

export interface AttributionReply extends ReadVerdict {
  evidence: number[];
  sourceName?: string;
  claimedSpeaker?: string;
  actualSpeaker?: string;
  actualSpeakerNamed?: boolean;
  speakerOrigin?: "cue" | "quote";
  period?: ClaimFacetPeriod;
  time?: "present" | "this-year" | "last-year" | "explicit";
}

const timeOf = (value: unknown): AttributionReply["time"] =>
  value === "present" || value === "this-year" || value === "last-year" || value === "explicit"
    ? value
    : undefined;

function facetField(reply: string): string | null {
  const label = [...reply.matchAll(/^[^\S\r\n]*Facets:[^\S\r\n]*/gm)].at(-1);
  if (label?.index === undefined) return null;
  const text = reply.slice(label.index + label[0].length).replace(/^[ \t\r\n]*/, "");
  if (text.charAt(0) !== "{") return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let at = 0; at < text.length; at++) {
    const char = text.charAt(at);
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      const tail = text.slice(at + 1).split(/[\r\n]/, 1)[0] ?? "";
      return /^(?:\s*\[\^[1-9]\d{0,3}\])*\s*$/.test(tail) ? text.slice(0, at + 1) : null;
    }
  }
  return null;
}

export function readAttributionReply(
  reply: string,
  original: string,
  requested: readonly ClaimPartPlan[],
): (AttributionReply | null)[] {
  const result: (AttributionReply | null)[] = requested.map(() => null);
  const field = facetField(reply);
  if (field === null) return result;
  let value: unknown;
  try {
    value = JSON.parse(field);
  } catch {
    return result;
  }
  if (!isRecord(value) || !Array.isArray(value.items)) return result;
  const valid = requested.map(
    (plan) =>
      plan.kind === "fact" && plan.facet !== undefined && readPartPlans([plan], original) !== null,
  );
  const seen = new Set<number>();
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      typeof item.text !== "string" ||
      item.text === "" ||
      typeof item.occurrence !== "number" ||
      !Number.isInteger(item.occurrence) ||
      item.occurrence < 1
    )
      continue;
    const text = item.text;
    let start = -1;
    for (let at = 0; at < item.occurrence; at++) {
      start = original.indexOf(text, start + 1);
      if (start < 0) break;
    }
    if (start < 0) continue;
    const matches = requested.flatMap((plan, at) =>
      valid[at] && plan.span.start === start && plan.span.end === start + text.length ? [at] : [],
    );
    const [at] = matches;
    if (matches.length !== 1 || at === undefined) continue;
    if (seen.has(at)) {
      result[at] = null;
      continue;
    }
    seen.add(at);
    const plan = requested[at];
    if (!plan || item.kind !== plan.facet?.kind) continue;
    if (
      item.verdict !== "supported" &&
      item.verdict !== "unsupported" &&
      item.verdict !== "contradicted"
    )
      continue;
    if (
      (item.scope !== "same" && item.scope !== "wider") ||
      (item.topic !== "found" && item.topic !== "not found") ||
      (item.roles !== "same" && item.roles !== "differs") ||
      (item.says !== null && typeof item.says !== "string") ||
      !Array.isArray(item.evidence)
    )
      continue;
    if (item.kind !== "time" && (Object.hasOwn(item, "period") || Object.hasOwn(item, "time")))
      continue;
    const sourceName =
      item.kind === "source" && typeof item.sourceName === "string" ? item.sourceName : undefined;
    if (item.kind === "source") {
      if (sourceName === undefined || !sourceNameIn(text, sourceName)) continue;
    } else if (Object.hasOwn(item, "sourceName")) continue;
    let speaker:
      | Pick<
          AttributionReply,
          "claimedSpeaker" | "actualSpeaker" | "actualSpeakerNamed" | "speakerOrigin"
        >
      | undefined;
    if (item.kind === "speaker") {
      if (
        typeof item.claimedSpeaker !== "string" ||
        item.claimedSpeaker.trim() === "" ||
        typeof item.actualSpeaker !== "string" ||
        item.actualSpeaker.trim() === "" ||
        typeof item.actualSpeakerNamed !== "boolean" ||
        (item.speakerOrigin !== "cue" && item.speakerOrigin !== "quote") ||
        !sourceNameIn(text, item.claimedSpeaker)
      )
        continue;
      speaker = {
        claimedSpeaker: item.claimedSpeaker,
        actualSpeaker: item.actualSpeaker,
        actualSpeakerNamed: item.actualSpeakerNamed,
        speakerOrigin: item.speakerOrigin,
      };
    } else if (
      ["claimedSpeaker", "actualSpeaker", "actualSpeakerNamed", "speakerOrigin"].some((key) =>
        Object.hasOwn(item, key),
      )
    )
      continue;
    const time = item.kind === "time" ? timeOf(item.time) : undefined;
    if (item.kind === "time" && time === undefined) continue;
    const period = time === undefined ? null : readClaimFacetPeriod(item.period);
    if (time !== undefined && item.period !== null && period === null) continue;
    const { verdict, scope, topic, roles, says, evidence } = item;
    const parsed = readVerdict(JSON.stringify({ verdict, scope, topic, roles, says, evidence }));
    if (!parsed?.evidence) continue;
    result[at] = {
      ...parsed,
      evidence: parsed.evidence,
      ...(sourceName !== undefined && { sourceName }),
      ...speaker,
      ...(time && { time }),
      ...(period && { period }),
    };
  }
  return result;
}
