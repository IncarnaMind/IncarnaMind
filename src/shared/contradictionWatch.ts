/**
 * The last check for contradictions in a Mind (#112): what a full watch of its
 * cited sentences found and cost, kept in the Mind's Yjs settings like its
 * model (`mindModel.ts`). A full watch is the background run a Folder's change
 * starts, and a run the User asked for; a scoped watch of a few sentences
 * writes nothing. `documentName` names the Document whose new version started
 * it, so the card can say "After X changed"; null when a Document joining the
 * Folder, the Mind joining it, or an on-demand run started it. Not content: an
 * older version leaves it as it is, and reads a run with no Document as one
 * with an unnamed Document.
 */
import type * as Y from "yjs";
import {
  type ContradictionWatchRun,
  type Currency,
  MIND_SETTINGS_FIELD,
  type Money,
  type RunStop,
  type WatchStop,
} from "../core/api";

const KEY = "contradictionWatch";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

const CURRENCIES: readonly Currency[] = ["USD", "CNY"];

function moneyOf(value: unknown): Money | null {
  if (!isRecord(value) || typeof value.amount !== "number") return null;
  const currency = CURRENCIES.find((each) => each === value.currency);
  return currency ? { currency, amount: value.amount } : null;
}

/** A run's stop as a record stored it; null for none, or one this version can't read. */
export function stopOf(value: unknown): RunStop | null {
  if (!isRecord(value)) return null;
  if (value.reason === "cost-cap") return { reason: "cost-cap" };
  if (value.reason === "plan-limit") {
    return {
      reason: "plan-limit",
      resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : null,
    };
  }
  return null;
}

/** A watch's stop as a record stored it: a Run's stop, or the User stopping it. */
function watchStopOf(value: unknown): WatchStop | null {
  if (isRecord(value) && value.reason === "cancelled") return { reason: "cancelled" };
  return stopOf(value);
}

/** The last full watch, or null for none (or one this version can't read). */
export function readContradictionWatch(settings: Y.Map<unknown>): ContradictionWatchRun | null {
  const value = settings.get(KEY);
  if (!isRecord(value) || typeof value.at !== "string") return null;
  return {
    at: value.at,
    documentName: typeof value.documentName === "string" ? value.documentName : null,
    claims: count(value.claims),
    checked: count(value.checked),
    contradicted: count(value.contradicted),
    cost: moneyOf(value.cost),
    stop: watchStopOf(value.stop),
    smallModel: value.smallModel === true,
  };
}

export const contradictionWatchOf = (doc: Y.Doc): ContradictionWatchRun | null =>
  readContradictionWatch(doc.getMap(MIND_SETTINGS_FIELD));

export function writeContradictionWatch(settings: Y.Map<unknown>, run: ContradictionWatchRun) {
  const { documentName, ...rest } = run;
  settings.set(KEY, {
    ...rest,
    ...(documentName !== null && { documentName }),
    cost: run.cost && { ...run.cost },
    stop: run.stop && { ...run.stop },
  });
}

/** Forgets the last run, once the User has closed its line. */
export const clearContradictionWatch = (settings: Y.Map<unknown>) => settings.delete(KEY);

/** Calls `listener` whenever the Mind's last run may have changed. Returns how to stop. */
export function observeContradictionWatch(doc: Y.Doc, listener: () => void): () => void {
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  settings.observe(listener);
  return () => settings.unobserve(listener);
}
