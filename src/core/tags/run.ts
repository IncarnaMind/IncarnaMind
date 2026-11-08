/**
 * A tagging run (#2339): the Documents an Organize run plans, or those the User asked to re-tag,
 * tagged before the Review opens, so it opens complete. A tagger that takes several Documents in
 * one request (the chat model) gets `TAG_BATCH` at a time, those most alike together so a topic
 * they share is named alike; any other is asked one Document at a time. A few requests go at
 * once. Nothing here decides who may be sent what: the caller's tagger comes through the tagging
 * flow's consent and gates, and the caller leaves out the Documents it may not send.
 */
import type { Language } from "../language";
import { dot } from "../library/plan";
import { classifyProviderError } from "../providers/providerErrors";
import { gateStop } from "../sendGate";
import {
  type DocumentExcerpt,
  kindDefinitions,
  type TagChoice,
  type TagClassifier,
  type TagDefinition,
} from "./classify";
import { TAG_KINDS, type TagKind } from "./kinds";
import { type ProposedTag, proposedTags } from "./proposals";
import { isTransient, RETRY_WAIT_MS } from "./transient";

/** How many Documents one request about several carries. */
export const TAG_BATCH = 10;
/** How many tagging requests a run has going at once. */
export const TAGGING_AT_ONCE = 3;

export interface TagRunSubject {
  id: string;
  /** What the request reads of it; a batch's is shorter (`BATCH_EXCERPT_TOKENS`). */
  excerpt: DocumentExcerpt;
}

export interface TagRunResult {
  /** Each Document's proposed Tags, none for one that got nothing. */
  proposed: Map<string, ProposedTag[]>;
  /** The Documents whose request couldn't reach the model. */
  unreachable: Set<string>;
  requests: number;
}

/**
 * The order to tag in: each group's Documents together (a plan's local clusters), and within a
 * group each one followed by the one most like it, so a batch holds Documents alike.
 */
export function batchOrder(
  vectors: readonly Float32Array[],
  groups: readonly number[] = [],
): number[] {
  const byGroup = new Map<number, number[]>();
  vectors.forEach((_, at) => {
    const group = groups[at] ?? 0;
    byGroup.set(group, [...(byGroup.get(group) ?? []), at]);
  });
  const order: number[] = [];
  for (const members of [...byGroup.keys()].sort((a, b) => a - b).map((key) => byGroup.get(key))) {
    const left = new Set(members);
    let at = members?.[0];
    while (at !== undefined) {
      order.push(at);
      left.delete(at);
      const here = vectors[at] as Float32Array;
      let next: number | undefined;
      let best = Number.NEGATIVE_INFINITY;
      for (const other of left) {
        const alike = dot(here, vectors[other] as Float32Array);
        if (alike > best) {
          best = alike;
          next = other;
        }
      }
      at = next;
    }
  }
  return order;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Runs `task` once more after a passing error, as the tagger does. */
async function once<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (!isTransient(error) || signal.aborted) throw error;
    await wait(RETRY_WAIT_MS.least + Math.random() * RETRY_WAIT_MS.jitter, signal);
    return task();
  }
}

/** A request's failure that leaves its Documents untagged rather than stopping the run. */
const unreached = (error: unknown) =>
  !gateStop(error) &&
  ["network", "provider", "rate-limit"].includes(classifyProviderError(error).kind);

/**
 * Tags `subjects`, in the order given, and returns what the run proposes for each. A failure
 * that reaching the model again might mend leaves its Documents untagged and goes on; any other
 * (a consent withdrawn, a key refused) ends the run and is thrown.
 */
export async function tagInRun(input: {
  tagger: TagClassifier;
  subjects: readonly TagRunSubject[];
  /** The kinds whose Tags the User has; every kind when left out. */
  kinds?: readonly TagKind[];
  /** The User's own Tags each Document is about (./about). */
  offered: ReadonlyMap<string, readonly TagDefinition[]>;
  language: Language;
  signal: AbortSignal;
  progress(done: number): void;
}): Promise<TagRunResult> {
  const { tagger, subjects, offered, language, signal, kinds = TAG_KINDS } = input;
  const choices = new Map<string, TagChoice>();
  const unreachable = new Set<string>();
  let requests = 0;
  let done = 0;
  const { decideMany } = tagger;
  const size = decideMany ? TAG_BATCH : 1;
  const batches: TagRunSubject[][] = [];
  for (let at = 0; at < subjects.length; at += size) batches.push(subjects.slice(at, at + size));
  const definitions = kindDefinitions(kinds);
  const ask = async (batch: TagRunSubject[]): Promise<Map<string, TagChoice>> => {
    requests++;
    if (decideMany)
      return decideMany({
        documents: batch.map(({ id, excerpt }) => ({
          ref: id,
          excerpt,
          tags: offered.get(id) ?? [],
        })),
        kinds,
        language,
        signal,
      });
    const [only] = batch;
    if (!only) return new Map();
    const choice = await tagger.decide({
      tags: [...definitions, ...(offered.get(only.id) ?? [])],
      excerpt: only.excerpt,
      language,
      signal,
    });
    return new Map([[only.id, choice]]);
  };
  let next = 0;
  // A refused key or a withdrawn consent ends the run: the other workers send nothing more.
  let ended = false;
  const worker = async () => {
    for (let batch = batches[next++]; batch && !signal.aborted && !ended; batch = batches[next++]) {
      try {
        const answered = await once(() => ask(batch), signal);
        for (const each of batch) {
          const choice = answered.get(each.id);
          if (choice) choices.set(each.id, choice);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!unreached(error)) {
          ended = true;
          throw error;
        }
        for (const each of batch) unreachable.add(each.id);
      }
      done += batch.length;
      input.progress(done);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TAGGING_AT_ONCE, batches.length) }, () => worker()),
  );
  return { proposed: proposedTags(choices), unreachable, requests };
}
