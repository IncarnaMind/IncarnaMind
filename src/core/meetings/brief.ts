import { asGenerated } from "../../shared/aiText";
import { citationNode, type NodeJSON } from "../../shared/blockJson";
import { cueTarget, parseCueTarget } from "../../shared/units";
import type { Citing } from "../answers/citing";
import type {
  CalendarAttendee,
  CoreApi,
  Meeting,
  MeetingBriefItem,
  MeetingBriefPreparation,
} from "../api";
import { MAX_ATTENDEES } from "../calendars/events";
import type { MemoCue } from "./memo";

export const BRIEF_DISMISSED = "meetingBriefDismissed";
export const QUESTIONS_DISMISSED = "meetingBriefQuestionsDismissed";

export function meetingBriefBlocks(
  labels: { history: string; invite: string; questions: string; missing: string },
  items: readonly MeetingBriefItem[],
  preparation: MeetingBriefPreparation | null,
): NodeJSON[] {
  const paragraph = (text: string): NodeJSON => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });
  const cited = (text: string, citation: MeetingBriefItem["citation"]): NodeJSON => ({
    type: "paragraph",
    content: [{ type: "text", text }, citationNode(citation)],
  });
  const nodes: NodeJSON[] = [];
  if (items.length)
    nodes.push(paragraph(labels.history), ...items.map((item) => cited(item.text, item.citation)));
  if (preparation?.invitation.length)
    nodes.push(
      paragraph(labels.invite),
      ...preparation.invitation.map((c) => cited(c.documentName, c)),
    );
  if (preparation?.questions.length) {
    nodes.push(paragraph(labels.questions));
    for (const { question, citation } of preparation.questions) {
      nodes.push(
        paragraph(question),
        citation ? cited(citation.quote, citation) : paragraph(labels.missing),
      );
    }
  }
  return asGenerated(nodes);
}

/** A display name can belong to another person. Match invitees only when every identity is known. */
export function meetingGuestKey(people: readonly CalendarAttendee[]): string | null {
  if (people.length >= MAX_ATTENDEES) return null;
  const guests = new Set<string>();
  for (const person of people) {
    if (person.self) continue;
    const address = person.email?.trim().toLowerCase();
    if (!address) return null;
    guests.add(address);
  }
  return guests.size ? JSON.stringify([...guests].sort()) : null;
}

type EarlierCall = Pick<Meeting, "id" | "mindId" | "summary"> & {
  title: string;
  documentId: string;
};

interface Options {
  earlier(): EarlierCall[];
  currentVersion(documentId: string): string | null;
  indexed(documentId: string): Promise<(MemoCue & { target: string })[]>;
  itemSources: CoreApi["getMeetingSummaryItemSources"];
  cite: Citing["citeUnit"];
}

async function checkedHistory(options: Options, call: EarlierCall): Promise<MeetingBriefItem[]> {
  const version = options.currentVersion(call.documentId);
  if (!version || !call.summary?.items?.some((item) => item.status === "active")) return [];
  const cues = await options.indexed(call.documentId);
  const result: MeetingBriefItem[] = [];
  for (const item of call.summary?.items ?? []) {
    if (item.status !== "active") continue;
    const evidence = await options.itemSources(call.id, item.id);
    if (evidence?.documentId !== call.documentId) continue;
    for (const source of evidence.sources) {
      const target = source.parentCue ?? source;
      const matches = cues.filter((cue) => {
        if (!cue.text.includes(source.text)) return false;
        if (!source.part) return cue.target === cueTarget(target.startMs, target.endMs);
        const bound = parseCueTarget(cue.target);
        return bound && bound.startMs <= source.startMs && bound.endMs >= source.endMs;
      });
      const [cue] = matches;
      if (matches.length !== 1 || !cue) continue;
      const offset = cue.text.indexOf(source.text);
      if (offset !== cue.text.lastIndexOf(source.text)) continue;
      const start = cue.at.start + offset;
      const citation = options.cite(cue.passageId, source.text, cue.page, {
        start,
        end: start + source.text.length,
      });
      if (
        citation?.check !== "found" ||
        citation.location?.kind !== "time" ||
        citation.contentHash !== version
      )
        continue;
      result.push({
        meetingId: call.id,
        itemId: item.id,
        kind: item.kind,
        text: item.text,
        title: call.title,
        citation,
      });
      break;
    }
  }
  return result;
}

/** Recheck access, meeting membership and manual edits after asynchronous transcript lookup. */
export async function readMeetingBriefHistory(options: Options): Promise<MeetingBriefItem[]> {
  const selected = options.earlier();
  if (!selected.length) return [];
  const sources = (await Promise.all(selected.map((call) => checkedHistory(options, call)))).flat();
  const current = new Map(options.earlier().map((call) => [call.id, call]));
  return sources.filter((source) => {
    const call = current.get(source.meetingId);
    if (
      !call ||
      call.title !== source.title ||
      call.documentId !== source.citation.documentId ||
      options.currentVersion(call.documentId) !== source.citation.contentHash
    )
      return false;
    return call.summary?.items?.some(
      (item) =>
        item.id === source.itemId &&
        item.status === "active" &&
        item.kind === source.kind &&
        item.text === source.text,
    );
  });
}
