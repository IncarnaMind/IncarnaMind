import { asGenerated } from "../../shared/aiText";
import type { NodeJSON } from "../../shared/blockJson";
import type { MeetingFact, MeetingOverview } from "./factProtocol";
import { FILL_SECTIONS, type FillSection } from "./fillPrompt";

export interface FactLine {
  marker: string;
  heading: boolean;
  ancestors: readonly string[];
}

export interface FactPlacementInput {
  facts: readonly MeetingFact[];
  overview: MeetingOverview | null;
  lines: readonly FactLine[];
  headings: ReadonlyMap<FillSection, string>;
  /** The User's headings no section is routed to: a topic in the same words goes under one. */
  topicHeadings: readonly { marker: string; text: string }[];
  claims: ReadonlySet<string>;
  reference: (topic: string, direction: "above" | "below") => string;
}

/** A topic of the call and its facts, in the order the call took it up. */
export interface PlacedTopic {
  title: string;
  /** The User's heading it goes under; null for a heading of its own after their notes. */
  heading: string | null;
  nodes: NodeJSON[];
}

export interface FactPlacement {
  lines: Map<string, NodeJSON[]>;
  sections: Map<FillSection, NodeJSON[]>;
  topics: PlacedTopic[];
  unplaced: number;
}

const SECTION_HOMES: readonly FillSection[] = ["actions", "decisions", "questions"];

/** Topics after the User's notes come between Summary and the sections that follow it. */
const TOPICS_ORDER = FILL_SECTIONS.indexOf("summary") + 0.5;

/** A topic's words as two of them are compared: case, width and spacing aside. */
export const topicKey = (title: string): string =>
  title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

interface FactPlace {
  position: number;
  ancestors: readonly string[];
}

function headingPlace(input: FactPlacementInput, marker: string | undefined, order: number) {
  const at = input.lines.findIndex((line) => line.heading && line.marker === marker);
  const heading = input.lines[at];
  if (!heading) return { position: input.lines.length + order, ancestors: [] };
  const next = input.lines.findIndex(
    (line, index) => index > at && line.heading && !line.ancestors.includes(heading.marker),
  );
  const end = next < 0 ? input.lines.length : next;
  return {
    position: end - 1 + (order + 1) / (FILL_SECTIONS.length + 1),
    ancestors: [...heading.ancestors, heading.marker],
  };
}

const sectionPlace = (input: FactPlacementInput, section: FillSection): FactPlace =>
  headingPlace(input, input.headings.get(section), FILL_SECTIONS.indexOf(section));

function append<K>(map: Map<K, NodeJSON[]>, key: K, nodes: readonly NodeJSON[]): void {
  const previous = map.get(key) ?? [];
  previous.push(...nodes);
  map.set(key, previous);
}

function factReference(
  fact: MeetingFact,
  input: FactPlacementInput,
  direction: "above" | "below",
): NodeJSON[] {
  return asGenerated([
    {
      type: "paragraph",
      content: [
        { type: "text", text: `${input.reference(fact.topic, direction)} ` },
        ...fact.citations,
      ],
    },
  ]);
}

export function placeFacts(input: FactPlacementInput): FactPlacement {
  const placed: FactPlacement = {
    lines: new Map(),
    sections: new Map(),
    topics: [],
    unplaced: 0,
  };
  if (input.overview) append(placed.sections, "summary", [input.overview.body]);
  const topics = new Map<string, PlacedTopic>();
  const hosts = new Map(input.topicHeadings.map((each) => [topicKey(each.text), each.marker]));
  const seen = new Set<string>();
  const ordinary = new Map(
    input.lines.flatMap((line, position) =>
      line.heading ? [] : [[line.marker, { position, ancestors: line.ancestors }] as const],
    ),
  );
  for (const fact of input.facts) {
    if (seen.has(fact.id)) continue;
    seen.add(fact.id);
    const requested = [...new Set(fact.lines)];
    const marker = requested.find((each) => ordinary.has(each));
    if (requested.some((each) => !ordinary.has(each))) placed.unplaced++;
    const sectionHome = SECTION_HOMES.find((section) => fact.sections.includes(section));
    const claimed = input.claims.has(fact.id);
    // A decision, an action or an open question is written whole in its section, so Action items
    // reads who does what by when; the User's line it answers points there, unless that line is
    // already in the section (#2306).
    const answered = marker === undefined ? undefined : ordinary.get(marker);
    const homeHeading = sectionHome && input.headings.get(sectionHome);
    const lineHome =
      answered &&
      (sectionHome === undefined ||
        (homeHeading !== undefined && answered.ancestors.includes(homeHeading)))
        ? answered
        : undefined;
    let home: FillSection | null = null;
    let canonical: FactPlace;
    if (lineHome && marker !== undefined) {
      append(placed.lines, marker, [fact.body]);
      canonical = lineHome;
    } else if (sectionHome || claimed) {
      // A topic's fact the User's Documents don't back moves to that list whole, so it is still
      // written once and the list holds what to check, not pointers (#2306).
      home = sectionHome ?? "claims";
      append(placed.sections, home, [fact.body]);
      canonical = sectionPlace(input, home);
    } else {
      const key = topicKey(fact.heading);
      const host = hosts.get(key);
      const topic = topics.get(key) ?? { title: fact.heading, heading: host ?? null, nodes: [] };
      topics.set(key, topic);
      topic.nodes.push(fact.body);
      canonical = host
        ? headingPlace(input, host, TOPICS_ORDER)
        : { position: input.lines.length + TOPICS_ORDER, ancestors: [] };
    }
    for (const secondary of requested) {
      const destination = ordinary.get(secondary);
      if ((lineHome && secondary === marker) || !destination) continue;
      append(
        placed.lines,
        secondary,
        factReference(fact, input, canonical.position < destination.position ? "above" : "below"),
      );
    }
    const references = new Set<FillSection>(
      fact.sections.filter((section) => section !== "summary" && section !== "claims"),
    );
    if (claimed) references.add("claims");
    for (const section of references) {
      if (section === home) continue;
      const heading = input.headings.get(section);
      if (heading !== undefined && canonical.ancestors.includes(heading)) continue;
      const destination = sectionPlace(input, section);
      append(
        placed.sections,
        section,
        factReference(fact, input, canonical.position < destination.position ? "above" : "below"),
      );
    }
  }
  placed.topics = [...topics.values()];
  return placed;
}
