import type { CitationLocation } from "../../src/core/api";
import type {
  BatesRange,
  RecordCiteKind,
  RecordCiteParseOptions,
} from "../../src/core/recordCites/parser";

export interface AcceptedRecordCiteFixture {
  shape: string;
  raw: string;
  kind: RecordCiteKind;
  sourceAlias: string | null;
  location: CitationLocation | null;
  bates: BatesRange | null;
  reference: "previous" | null;
  options?: RecordCiteParseOptions;
}

const previous = { hasPrevious: true } as const;

const directFixture = (
  shape: string,
  raw: string,
  kind: RecordCiteKind,
  sourceAlias: string | null,
  location: CitationLocation,
): AcceptedRecordCiteFixture => ({
  shape,
  raw,
  kind,
  sourceAlias,
  location,
  bates: null,
  reference: null,
});

const batesFixture = (
  shape: string,
  raw: string,
  prefix: string,
  from: string,
  to = from,
): AcceptedRecordCiteFixture => ({
  shape,
  raw,
  kind: "bates",
  sourceAlias: prefix.toLocaleLowerCase(),
  location: null,
  bates: { prefix, from, to },
  reference: null,
});

const previousFixture = (
  shape: string,
  raw: string,
  kind: "id" | "supra",
  location: CitationLocation | null,
): AcceptedRecordCiteFixture => ({
  shape,
  raw,
  kind,
  sourceAlias: null,
  location,
  bates: null,
  reference: "previous",
  options: previous,
});

const page = (from: number, to = from): CitationLocation => ({ kind: "page", from, to });

const depositionLocation = (
  from: number,
  to: number,
  lineFrom: number,
  lineTo: number,
): CitationLocation => ({
  kind: "page",
  from,
  to,
  printed: { from: String(from), to: String(to) },
  lines: { from: lineFrom, to: lineTo },
});

const paragraphLocation = (from: number, to = from): CitationLocation => ({
  kind: "section",
  heading: null,
  paragraphs: { from, to },
});

const timeLocation = (from: number, to = from): CitationLocation => ({
  kind: "time",
  from: from * 1000,
  to: to * 1000,
});

const ten = (make: (index: number) => AcceptedRecordCiteFixture) =>
  Array.from({ length: 10 }, (_, index) => make(index));

const names = [
  "Smith",
  "Jones",
  "Garcia",
  "Chen",
  "Patel",
  "Brown",
  "Davis",
  "Lee",
  "Martin",
  "Taylor",
];
const padded = (value: number, width: number) => String(value).padStart(width, "0");

export const ACCEPTED_RECORD_CITE_FIXTURES: readonly AcceptedRecordCiteFixture[] = [
  ...ten((index) => {
    const name = names[index] ?? "Smith";
    return directFixture(
      "named deposition, one page",
      `${name} Dep. ${45 + index}:3–${12 + index}`,
      "deposition",
      `${name.toLocaleLowerCase()} dep`,
      depositionLocation(45 + index, 45 + index, 3, 12 + index),
    );
  }),
  ...ten((index) =>
    directFixture(
      "deposition transcript, one page",
      `Dep. Tr. ${45 + index}:3-${12 + index}`,
      "deposition",
      "dep tr",
      depositionLocation(45 + index, 45 + index, 3, 12 + index),
    ),
  ),
  ...ten((index) => {
    const name = names[index] ?? "Smith";
    return directFixture(
      "deposition across a page break",
      `${name} Dep. ${45 + index}:24–${46 + index}:2`,
      "deposition",
      `${name.toLocaleLowerCase()} dep`,
      depositionLocation(45 + index, 46 + index, 24, 2),
    );
  }),
  ...ten((index) =>
    directFixture(
      "exhibit with at",
      `Ex. ${index + 1} at ${index + 3}`,
      "exhibit",
      `ex ${index + 1}`,
      page(index + 3),
    ),
  ),
  ...ten((index) =>
    directFixture(
      "plaintiff exhibit with p.",
      `Pl.'s Ex. ${index + 1}, p. ${index + 3}`,
      "exhibit",
      `pl's ex ${index + 1}`,
      page(index + 3),
    ),
  ),
  ...ten((index) =>
    directFixture(
      "ECF docket entry",
      `ECF No. ${41 + index} at ${5 + index}`,
      "docket",
      `ecf no ${41 + index}`,
      page(5 + index),
    ),
  ),
  ...ten((index) =>
    directFixture(
      "Dkt. docket entry",
      `Dkt. ${41 + index} at ${5 + index}`,
      "docket",
      `dkt ${41 + index}`,
      page(5 + index),
    ),
  ),
  ...ten((index) => {
    const number = padded(123 + index, 6);
    return batesFixture("single Bates identifier", `PL-${number}`, "PL", number);
  }),
  ...ten((index) => {
    const from = padded(45 + index * 10, 4);
    const to = padded(49 + index * 10, 4);
    return batesFixture("Bates range", `DEF ${from}–${to}`, "DEF", from, to);
  }),
  ...ten((index) =>
    directFixture(
      "one complaint paragraph",
      `Compl. ¶ ${14 + index}`,
      "paragraph",
      "compl",
      paragraphLocation(14 + index),
    ),
  ),
  ...ten((index) => {
    const name = names[index] ?? "Smith";
    return directFixture(
      "declaration paragraph range",
      `${name} Decl. ¶¶ ${3 + index}–${5 + index}`,
      "paragraph",
      `${name.toLocaleLowerCase()} decl`,
      paragraphLocation(3 + index, 5 + index),
    );
  }),
  ...ten((index) => {
    const from = (14 + index) * 60 + 20 + index;
    return directFixture(
      "transcript time",
      `${14 + index}:${20 + index}`,
      "time",
      null,
      timeLocation(from),
    );
  }),
  ...ten((index) => {
    const from = 3740 + index;
    const to = 3750 + index;
    return directFixture(
      "transcript time range",
      `${index % 2 === 0 ? "at " : ""}1:02:${padded(20 + index, 2)}–1:02:${padded(30 + index, 2)}`,
      "time",
      null,
      timeLocation(from, to),
    );
  }),
  ...ten((index) => previousFixture("Id.", index % 2 === 0 ? "Id." : "id.", "id", null)),
  ...ten((index) =>
    previousFixture("Id. with a new page", `Id. at ${7 + index}`, "id", page(7 + index)),
  ),
  ...ten((index) => previousFixture("supra", index % 2 === 0 ? "supra" : "SUPRA", "supra", null)),
];
