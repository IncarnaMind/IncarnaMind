/**
 * What a task of the any-analysis set is (README.md): its inputs, written from a
 * fixed seed, its question in plain words, what it needs, and what its Answer
 * must contain. The values an Answer is held to come from the task's
 * reference.json, which its reference.py works out from the same inputs: the
 * app never sees either.
 */

/**
 * What a task needs, beyond a model:
 * - P: fits the Analysis sandbox today (Pyodide, 20,000 rows or 500,000 cells, 60 s, 6 runs);
 * - N: a native runtime or bigger limits (#2351);
 * - F: the workbook's formulas, not only its values;
 * - T: a table from a PDF, Word or PowerPoint Document as an input (#448);
 * - X: live Excel formulas out (#451).
 */
export type Need = "P" | "N" | "F" | "T" | "X";

export type TaskLanguage = "en" | "zh";

/** A file the User has: written into the task's folder and added to the Library, or not, if the app reads no such file. */
export interface TaskFile {
  name: string;
  bytes: Uint8Array;
}

/** What a task is given: the User's files, and the plain data its reference.py reads them as. */
export interface TaskInputs {
  files: TaskFile[];
  /** Files only reference.py reads (CSV or JSON text), by name: the values the User's files hold. */
  data: Record<string, string>;
}

/**
 * How far a number may be from the reference: `abs` in the number's own units
 * (a percent's as a fraction), `rel` as a share of the reference. With neither,
 * it must be the same to Excel's 15 significant digits.
 */
export interface Tolerance {
  abs?: number;
  rel?: number;
}

/** What a number measures, as the Answer may write it. */
export type NumberKind =
  /** A share, written "12.3%" or as a fraction, 0.123. */
  | "percent"
  /** An amount, a count, a statistic: written as a plain number, or with a currency. */
  | "plain";

interface Expected {
  /** The key of its value in reference.json. */
  id: string;
  /** What it is, in a report: "Total interest". */
  label: string;
}

/** One number: the reference's value, or any of its values when it gives a list (each a right answer). */
export interface ExpectedNumber extends Expected {
  kind: "number";
  unit: NumberKind;
  tolerance: Tolerance;
  /** Words on the line that states it, in English and Chinese: where the scorer looks first. */
  near?: RegExp;
  /** Its sign doesn't count: a variance "over budget by 1,200" for -1,200. */
  signless?: boolean;
}

/** A column of `ExpectedRows`: a number each row must state. */
export interface ExpectedColumn {
  id: string;
  unit: NumberKind;
  tolerance: Tolerance;
  signless?: boolean;
}

/**
 * A list of items, each named by a key the text writes (a cost centre's code, a
 * customer's), with the numbers each must state on its own line or table row.
 * The reference gives `[{ key: "CC07", amount: 1250.5, share: 0.081 }, …]`.
 * Every item must be there, and no other key in the list: a missing or extra
 * item fails.
 */
export interface ExpectedRows extends Expected {
  kind: "rows";
  /** Finds every key in a line, after full-width characters are read as ASCII: /\bCC\d{2}\b/g. */
  key: RegExp;
  columns: ExpectedColumn[];
  /** The order counts: "worst first". */
  ordered?: boolean;
}

/** Something the Answer must say: a warning, a test's name, the leaking column, in English or Chinese. */
export interface ExpectedMention extends Expected {
  kind: "mention";
  match: RegExp;
}

/** Pictures the Analyses drew and the Answer shows: a scree plot, a partial-dependence plot. */
export interface ExpectedPicture extends Expected {
  kind: "picture";
  count: number;
}

/** A file the Answer saved: a workbook with at least `formulas` live formula cells. */
export interface ExpectedFile extends Expected {
  kind: "file";
  extension: string;
  formulas: number;
}

export type Expectation =
  | ExpectedNumber
  | ExpectedRows
  | ExpectedMention
  | ExpectedPicture
  | ExpectedFile;

/** Where the Answer's inputs must come from, for C2. */
export interface ExpectedSources {
  /** Documents an Analysis must read or a Citation must cite, by file name. */
  documents?: string[];
  /** Results whose line must cite this page: { growth: 41 }. */
  pages?: Record<string, number>;
}

export interface Task {
  /** "F01", as the set lists it. */
  id: string;
  /** What it is about, in a few words: "Budget against actual". */
  title: string;
  needs: Need[];
  seed: number;
  /** English always; Chinese too for eight tasks, with Chinese headings and full-width digits in the data. */
  question: { en: string; zh?: string };
  /** The task's files and data, the same bytes every time for a language. */
  inputs(language: TaskLanguage): TaskInputs;
  expect: Expectation[];
  sources?: ExpectedSources;
  /** Its inputs are too large to commit or to write in a unit test: written when the set runs. */
  large?: boolean;
}

/**
 * reference.json: what reference.py worked out from the English inputs' data, which the
 * Chinese inputs share, and the inputs per language it holds for (`inputsHash`), so a
 * generator that changes shows.
 */
export interface Reference {
  task: string;
  inputs: Partial<Record<TaskLanguage, string>>;
  values: Record<string, ReferenceValue>;
}

export type ReferenceRow = { key: string } & Record<string, number | string>;

export type ReferenceValue = number | number[] | string | string[] | ReferenceRow[] | null;
