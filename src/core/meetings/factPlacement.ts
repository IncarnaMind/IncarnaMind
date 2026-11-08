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
  claims: ReadonlySet<string>;
  reference: (topic: string, direction: "above" | "below") => string;
}

export interface FactPlacement {
  lines: Map<string, NodeJSON[]>;
  sections: Map<FillSection, NodeJSON[]>;
  unplaced: number;
}

const FULL_SECTION_ORDER: readonly FillSection[] = ["actions", "decisions", "questions", "summary"];

interface FactPlace {
  position: number;
  ancestors: readonly string[];
}

function sectionPlace(input: FactPlacementInput, section: FillSection): FactPlace {
  const order = FILL_SECTIONS.indexOf(section);
  const marker = input.headings.get(section);
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
  const placed: FactPlacement = { lines: new Map(), sections: new Map(), unplaced: 0 };
  if (input.overview) append(placed.sections, "summary", [input.overview.body]);
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
    const sectionHome = FULL_SECTION_ORDER.find((section) => fact.sections.includes(section));
    const home = sectionHome ?? "summary";
    if (requested.some((each) => !ordinary.has(each)) || (marker === undefined && !sectionHome)) {
      placed.unplaced++;
    }
    // A decision, an action or an open question is written whole in its section, so Action items
    // reads who does what by when; the User's line it answers points there, unless that line is
    // already in the section (#2306).
    const answered = marker === undefined ? undefined : ordinary.get(marker);
    const homeHeading = input.headings.get(home);
    const lineHome =
      answered &&
      (home === "summary" ||
        (homeHeading !== undefined && answered.ancestors.includes(homeHeading)))
        ? answered
        : undefined;
    if (lineHome && marker !== undefined) append(placed.lines, marker, [fact.body]);
    else append(placed.sections, home, [fact.body]);
    const canonical = lineHome ?? sectionPlace(input, home);
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
    if (input.claims.has(fact.id)) references.add("claims");
    for (const section of references) {
      if (!lineHome && section === home) continue;
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
  return placed;
}
