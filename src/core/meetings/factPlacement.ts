import { asGenerated } from "../../shared/aiText";
import type { NodeJSON } from "../../shared/blockJson";
import type { MeetingFact, MeetingOverview } from "./factProtocol";
import { FILL_SECTIONS, type FillSection } from "./fillPrompt";
import type { WriteupPlan } from "./writeupTemplates";

export interface FactLine {
  marker: string;
  heading: boolean;
  ancestors: readonly string[];
}

export interface FactPlacementInput {
  facts: readonly MeetingFact[];
  /** A call read in parts has one for each part, in the order it was read (#3151). */
  overviews: readonly MeetingOverview[];
  lines: readonly FactLine[];
  headings: ReadonlyMap<FillSection, string>;
  /** The User's headings: a topic in the same words goes under one, and into the section routed to it. */
  topicHeadings: readonly { marker: string; text: string }[];
  claims: ReadonlySet<string>;
  reference: (topic: string, direction: "above" | "below") => string;
  /** The ordinary lines the model said the call doesn't answer, and the sentence written under one. */
  unanswered: ReadonlySet<string>;
  notMentioned: string;
  template?: WriteupPlan;
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
const topicKey = (title: string): string =>
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

function placeTemplateFacts(input: FactPlacementInput, template: WriteupPlan): FactPlacement {
  const lines = new Map<string, NodeJSON[]>();
  const sections = new Map<FillSection, NodeJSON[]>();
  const positions = new Map(
    input.lines.flatMap((line, index) => (line.heading ? [] : [[line.marker, index] as const])),
  );
  const claimPlace = sectionPlace(input, "claims");
  const hosts = new Map(input.topicHeadings.map((heading) => [topicKey(heading.text), heading]));
  const titles = new Map(template.sections.map((title) => [topicKey(title), title]));
  const topics = new Map<string, PlacedTopic>();
  for (const fact of input.facts) {
    const related = [...new Set(fact.lines)].filter((marker) => positions.has(marker));
    if (input.claims.has(fact.id)) {
      append(sections, "claims", [fact.body]);
      for (const marker of related) {
        const direction = claimPlace.position < (positions.get(marker) ?? 0) ? "above" : "below";
        append(lines, marker, factReference(fact, input, direction));
      }
      continue;
    }
    const first = related[0];
    if (first !== undefined) {
      append(lines, first, [fact.body]);
      for (const marker of related.slice(1)) {
        const direction =
          (positions.get(first) ?? 0) < (positions.get(marker) ?? 0) ? "above" : "below";
        append(lines, marker, factReference(fact, input, direction));
      }
      continue;
    }
    const key = topicKey(fact.heading);
    const host = hosts.get(key);
    if (!host && (!template.fillUncovered || (titles.size > 0 && !titles.has(key)))) continue;
    const topic = topics.get(key) ?? {
      title: host?.text ?? titles.get(key) ?? fact.heading,
      heading: host?.marker ?? null,
      nodes: [],
    };
    topic.nodes.push(fact.body);
    topics.set(key, topic);
  }
  fillUnanswered(input, positions.keys(), lines);
  const written = [...topics];
  const topicsByTemplate = [
    ...written.filter(([, topic]) => topic.heading !== null).map(([, topic]) => topic),
    ...(titles.size > 0
      ? [...titles.keys()].flatMap((key) => {
          const topic = topics.get(key);
          return topic && topic.heading === null ? [topic] : [];
        })
      : written.filter(([, topic]) => topic.heading === null).map(([, topic]) => topic)),
  ];
  return { lines, sections, topics: topicsByTemplate, unplaced: 0 };
}

function fillUnanswered(
  input: FactPlacementInput,
  ordinary: Iterable<string>,
  lines: Map<string, NodeJSON[]>,
): void {
  for (const marker of ordinary) {
    if (!input.unanswered.has(marker) || lines.has(marker)) continue;
    lines.set(
      marker,
      asGenerated([{ type: "paragraph", content: [{ type: "text", text: input.notMentioned }] }]),
    );
  }
}

export function placeFacts(input: FactPlacementInput): FactPlacement {
  if (input.template) return placeTemplateFacts(input, input.template);
  const placed: FactPlacement = {
    lines: new Map(),
    sections: new Map(),
    topics: [],
    unplaced: 0,
  };
  for (const overview of input.overviews) append(placed.sections, "summary", [overview.body]);
  const topics = new Map<string, PlacedTopic>();
  const hosts = new Map(input.topicHeadings.map((each) => [topicKey(each.text), each.marker]));
  const sectionsByHeading = new Map(
    [...input.headings].map(([section, marker]) => [marker, section] as const),
  );
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
    // A statement the User's Documents don't back is written whole in that list, and the User's
    // line it answers points there, so the list holds what to check, never pointers (#2306).
    const home =
      sectionHome ?? (input.claims.has(fact.id) ? ("claims" satisfies FillSection) : undefined);
    // A decision, an action or an open question is written whole in its section, so Action items
    // reads who does what by when; the User's line it answers points there, unless that line is
    // already in the section (#2306).
    const answered = marker === undefined ? undefined : ordinary.get(marker);
    const homeHeading = home && input.headings.get(home);
    const lineHome =
      answered &&
      (home === undefined ||
        (homeHeading !== undefined && answered.ancestors.includes(homeHeading)))
        ? answered
        : undefined;
    let placedIn: FillSection | null = null;
    let canonical: FactPlace;
    if (lineHome && marker !== undefined) {
      append(placed.lines, marker, [fact.body]);
      canonical = lineHome;
    } else if (home) {
      append(placed.sections, home, [fact.body]);
      placedIn = home;
      canonical = sectionPlace(input, home);
    } else {
      const key = topicKey(fact.heading);
      const named = hosts.get(key);
      const section = named === undefined ? undefined : sectionsByHeading.get(named);
      // The list of what to check holds only the statements the check left unbacked: any other
      // fact named after its heading keeps a heading of its own.
      const host = section === "claims" ? undefined : named;
      const hostSection = host === undefined ? undefined : section;
      if (hostSection) {
        // The heading it names is the User's own heading for a section: it joins that section's
        // items, never a second heading with the same words (#2306).
        append(placed.sections, hostSection, [fact.body]);
        placedIn = hostSection;
        canonical = sectionPlace(input, hostSection);
      } else {
        const topic = topics.get(key) ?? { title: fact.heading, heading: host ?? null, nodes: [] };
        topics.set(key, topic);
        topic.nodes.push(fact.body);
        canonical = host
          ? headingPlace(input, host, TOPICS_ORDER)
          : { position: input.lines.length + TOPICS_ORDER, ancestors: [] };
      }
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
    for (const section of references) {
      if (section === placedIn) continue;
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
  fillUnanswered(input, ordinary.keys(), placed.lines);
  placed.topics = [...topics.values()];
  return placed;
}
