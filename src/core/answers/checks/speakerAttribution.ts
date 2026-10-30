import { joinUnits, parseLocation, quoteInUnits } from "../../../shared/locations";
import { isNamedSpeaker } from "../../../shared/speakers";
import { normaliseText } from "../../../shared/text";
import { parseCueTarget, type UnitText } from "../../../shared/units";
import type { Citation } from "../../api";
import { matchingOf } from "../citations";
import { sourceNameIn } from "./sourceAttribution";

export interface SpeakerAttributionInput {
  words: string;
  claimedSpeaker: unknown;
  actualSpeaker: unknown;
  actualSpeakerNamed: unknown;
  speakerOrigin: unknown;
  proofs: readonly { citation: Citation; units: readonly UnitText[] }[];
}

export interface SpeakerAttribution {
  outcome: "other" | "unknown" | null;
  speaker: string;
}

const nameKey = (name: string) => normaliseText(name).toLocaleLowerCase();

export function speakerAttribution(input: SpeakerAttributionInput): SpeakerAttribution | null {
  const { words, claimedSpeaker, actualSpeaker, actualSpeakerNamed, speakerOrigin, proofs } = input;
  if (
    typeof claimedSpeaker !== "string" ||
    claimedSpeaker.trim() === "" ||
    typeof actualSpeaker !== "string" ||
    actualSpeaker.trim() === "" ||
    typeof actualSpeakerNamed !== "boolean" ||
    (speakerOrigin !== "cue" && speakerOrigin !== "quote") ||
    !sourceNameIn(words, claimedSpeaker) ||
    proofs.length === 0 ||
    proofs.some(({ citation }) => citation.check !== "found")
  )
    return null;
  let speaker = actualSpeaker.trim();
  let named = actualSpeakerNamed && isNamedSpeaker(speaker);
  if (speakerOrigin === "quote") {
    if (!proofs.some(({ citation }) => sourceNameIn(citation.quote, speaker))) return null;
  } else {
    const voices: string[] = [];
    for (const { citation, units } of proofs) {
      if (
        parseLocation(citation.location)?.kind !== "time" ||
        units.length === 0 ||
        units.some((unit) => unit.kind !== "cues")
      )
        return null;
      const ranges = quoteInUnits(units, citation.quote, { ...matchingOf(units), unique: true });
      if (!ranges) return null;
      const { starts } = joinUnits(units);
      for (const [at, unit] of units.entries()) {
        const offset = starts[at];
        if (offset === undefined) return null;
        if (!ranges.some((range) => range.start < offset + unit.text.length && range.end > offset))
          continue;
        let covered = false;
        for (const [index, anchor] of (unit.anchors ?? []).entries()) {
          if (
            !ranges.some(
              (range) => range.start < offset + anchor.end && range.end > offset + anchor.start,
            )
          )
            continue;
          const cue = parseCueTarget(anchor.target);
          const voice = unit.label?.speakers?.[index]?.trim();
          if (
            !cue ||
            !Number.isFinite(cue.startMs) ||
            !Number.isFinite(cue.endMs) ||
            cue.endMs < cue.startMs ||
            !voice
          )
            return null;
          covered = true;
          voices.push(voice);
        }
        if (!covered) return null;
      }
    }
    const identities = new Set(voices.map(nameKey));
    const first = voices[0];
    if (identities.size !== 1 || first === undefined) return null;
    speaker = first;
    named = voices.every(isNamedSpeaker);
  }
  return {
    speaker,
    outcome: nameKey(claimedSpeaker) === nameKey(speaker) ? null : named ? "other" : "unknown",
  };
}
