import type { Document, MeetingSpeakerSuggestion, TranscriptSpeakers } from "../../../core/api";
import type { Cue } from "../../../core/documents/formats/vtt";
import {
  isTheirs,
  type LinePart,
  lineKey,
  partsOf,
  SPEAKER_ME,
  speakerOf,
  type TranscriptLine,
} from "../../../shared/speakers";
import { fileLineOf } from "./transcriptTurnRows";

export function reviewSpeakersMatch(
  reviewed: TranscriptSpeakers | null | undefined,
  current: TranscriptSpeakers | null,
) {
  return reviewed === undefined || JSON.stringify(reviewed) === JSON.stringify(current);
}

export function suggestionLines(cues: readonly Cue[], speakers: TranscriptSpeakers | null) {
  const lines = new Map<string, LinePart | null>();
  for (const cue of cues) {
    if (!cue.speaker || cue.speaker === SPEAKER_ME) continue;
    for (const part of partsOf(speakers, fileLineOf(cue))) {
      const key = lineKey(part.startMs, part.label);
      lines.set(key, lines.has(key) ? null : part);
    }
  }
  return lines;
}

export function suggestionLine(
  document: Pick<Document, "speakers" | "contentHash">,
  lines: ReadonlyMap<string, LinePart | null>,
  contentHash: string,
  suggestion: MeetingSpeakerSuggestion,
  expectedLabel = suggestion.currentLabel,
): TranscriptLine | null {
  const { startMs, endMs, text, fileLabel, currentLabel, suggestedLabel } = suggestion;
  const speakers = document.speakers;
  if (
    document.contentHash !== contentHash ||
    fileLabel === SPEAKER_ME ||
    currentLabel === SPEAKER_ME ||
    !isTheirs(suggestedLabel) ||
    suggestedLabel === currentLabel ||
    speakerOf(speakers, startMs, fileLabel) !== expectedLabel
  )
    return null;

  const part = lines.get(lineKey(startMs, fileLabel));
  return part?.endMs === endMs && part.text === text ? { startMs, label: fileLabel } : null;
}
