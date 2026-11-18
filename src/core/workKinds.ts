/**
 * What the User works on, as the first run's setup asks it (#3296), and the example each kind
 * leads to. Pure, and importing only ./api: the renderer imports it too.
 */
import { type ExampleGroup, WORK_KINDS, type WorkKind } from "./api";

export const EXAMPLE_FOR_WORK: Readonly<Record<WorkKind, ExampleGroup>> = {
  finance: "credit",
  legal: "contracts",
  research: "papers",
  reports: "reports",
  meetings: "meetings",
  other: "credit",
};

export const isWorkKind = (value: unknown): value is WorkKind =>
  typeof value === "string" && (WORK_KINDS as readonly string[]).includes(value);

/**
 * Picks as the setup keeps them: each kind once, in the order picked. Null for anything else.
 */
export function pickedWork(value: unknown): WorkKind[] | null {
  if (!Array.isArray(value) || !value.every(isWorkKind)) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value];
}

/** The examples the picks make, the first pick's first; nothing picked is Something else's. */
export function exampleGroupsOf(work: readonly WorkKind[]): ExampleGroup[] {
  const groups = (work.length > 0 ? work : (["other"] as const)).map(
    (kind) => EXAMPLE_FOR_WORK[kind],
  );
  return [...new Set(groups)];
}

/** The example a first run opens on: the first pick's, the credit paper when none was. */
export const leadGroupOf = (work: readonly WorkKind[]): ExampleGroup =>
  EXAMPLE_FOR_WORK[work[0] ?? "other"];
