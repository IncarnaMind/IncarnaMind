/**
 * Organize's plan for a whole Library, at any size (#1569): every readable Document is placed
 * from vectors kept on this computer, and the model sees a fixed sample, so what is sent stays
 * flat as the Library grows.
 *
 * 1. Each Document's vector: the mean of its Passage vectors when search embeddings are on and
 *    all there, else a vector of its words (TF-IDF, CJK as character pairs), projected to
 *    `PROJECTED` dimensions. Both are centred: their shared direction says nothing about topics.
 * 2. Local clusters by spherical k-means, finer than the Folders will be. k is the one in
 *    `CLUSTERS` with the highest mean silhouette, in its centroid form (`silhouette`), so it
 *    needs no pairwise distances.
 * 3. The `SAMPLE` Documents nearest the clusters' centres, spread evenly over them, go to the
 *    model in one request, which proposes up to `MOST_NEW` Folders beside the User's own and puts
 *    each sampled Document in one, or in none.
 * 4. A cluster whose sampled Documents all went to the same Folder sends its other Documents
 *    there, unless one sits near a cluster that went elsewhere (`CLEAR`) or the sampled Document
 *    most like it went elsewhere. The rest are asked of the model, `PLACE_BATCH` to a request.
 *    Only the model leaves a Document out.
 * 5. Three or more left out that no sample showed get a second look, which may find an area
 *    they share: a Folder for them, and every Document still left out is placed again.
 * 6. A new Folder left with fewer than `MIN_FOLDER` is dropped. A new Folder of more than
 *    `SPLIT_OVER` is split by its vectors into 2 to 5 subfolders of at least `MIN_SUBFOLDER`,
 *    which one more request names.
 *
 * On generated Libraries of 500 and 1,000 Documents with the labels as the model's answers,
 * steps 2–4 placed 98% where the labels put them, asking the model about a quarter of them.
 */
import { isCjk } from "../../shared/text";
import type { Language } from "../language";

/** How many Documents the model sees to propose Folders: every one of a Library this small. */
export const SAMPLE = 48;
/** Local clusters tried, at most a fifth of the Documents. */
export const CLUSTERS = { min: 3, max: 24 } as const;
/** The silhouette under which a Document's own cluster isn't clearly its place. */
export const CLEAR = 0.4;
export const PLACE_BATCH = 25;
export const MIN_FOLDER = 3;
/** The most new Folders a plan proposes, subfolders aside: the top level stays glanceable. */
export const MOST_NEW = 7;
/** How many Folders a plan aims at, which Fewer Folders and More Folders move within 3 to 7. */
export interface FolderAim {
  least: number;
  most: number;
}
export const AIM: FolderAim = { least: 3, most: MOST_NEW };
export const SPLIT_OVER = 40;
export const MIN_SUBFOLDER = 5;
export const SUBFOLDERS = { min: 2, max: 5 } as const;
/** Subfolder Documents the naming request sees, from each. */
const SUBFOLDER_SAMPLE = 3;
/** Requests to the model at once while placing. */
const PLACING_AT_ONCE = 4;
/** The dimensions a word vector is projected to. */
export const PROJECTED = 256;
/** The most terms a word vector counts: those in the most Documents, past the commonest. */
const VOCABULARY = 4096;
const PROJECTION_SEED = 0x9e3779b9;

// --- Vectors ------------------------------------------------------------------------------

export const dot = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += (a[index] ?? 0) * (b[index] ?? 0);
  return sum;
};

export function normalized(vector: Float32Array): Float32Array {
  const length = Math.sqrt(dot(vector, vector));
  if (length === 0) return vector;
  for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) / length;
  return vector;
}

/** The vectors less their mean, normalised again. */
export function centred(vectors: readonly Float32Array[]): Float32Array[] {
  const first = vectors[0];
  if (!first) return [];
  const mean = new Float32Array(first.length);
  for (const vector of vectors)
    for (let index = 0; index < mean.length; index++)
      mean[index] = (mean[index] ?? 0) + (vector[index] ?? 0) / vectors.length;
  return vectors.map((vector) =>
    normalized(vector.map((value, index) => value - (mean[index] ?? 0))),
  );
}

/** A small, seeded generator (mulberry32), so the same Library gets the same plan. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hashOf = (text: string): number => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};

const HAN_RUN = /\p{Script=Han}+/gu;
const WORD = /[\p{L}\p{N}]+/gu;

/** A text's terms: its words of two letters or more, and its Chinese as character pairs. */
export function termsOf(text: string): string[] {
  const terms: string[] = [];
  for (const run of text.match(HAN_RUN) ?? []) {
    const characters = Array.from(run).filter(isCjk);
    if (characters.length === 1) terms.push(run);
    for (let index = 0; index + 1 < characters.length; index++)
      terms.push(`${characters[index]}${characters[index + 1]}`);
  }
  for (const word of text.replace(HAN_RUN, " ").toLowerCase().match(WORD) ?? []) {
    if (word.length < 2 || /^\p{N}+$/u.test(word)) continue;
    terms.push(word);
  }
  return terms;
}

/** A term's fixed random direction: the projection keeps the angles between word vectors. */
function directionOf(term: string): Float32Array {
  const next = random(hashOf(term) ^ PROJECTION_SEED);
  const direction = new Float32Array(PROJECTED);
  for (let index = 0; index < PROJECTED; index++) direction[index] = next() < 0.5 ? -1 : 1;
  return direction;
}

/**
 * Each text's TF-IDF vector over the terms that two or more of them share and at most half
 * hold, projected to `PROJECTED` dimensions and normalised. A text with none is all zeros.
 */
export function wordVectors(texts: readonly string[]): Float32Array[] {
  const counts = texts.map((text) => {
    const count = new Map<string, number>();
    for (const term of termsOf(text)) count.set(term, (count.get(term) ?? 0) + 1);
    return count;
  });
  const holding = new Map<string, number>();
  for (const count of counts)
    for (const term of count.keys()) holding.set(term, (holding.get(term) ?? 0) + 1);
  const most = Math.max(2, Math.floor(texts.length / 2));
  const kept = [...holding]
    .filter(([, held]) => held >= 2 && held <= most)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, VOCABULARY);
  const weights = new Map(
    kept.map(([term, held]) => [term, Math.log((texts.length + 1) / (held + 1)) + 1]),
  );
  const directions = new Map<string, Float32Array>();
  return counts.map((count) => {
    const vector = new Float32Array(PROJECTED);
    for (const [term, times] of count) {
      const weight = weights.get(term);
      if (weight === undefined) continue;
      let direction = directions.get(term);
      if (!direction) {
        direction = directionOf(term);
        directions.set(term, direction);
      }
      const value = (1 + Math.log(times)) * weight;
      for (let index = 0; index < PROJECTED; index++)
        vector[index] = (vector[index] ?? 0) + value * (direction[index] ?? 0);
    }
    return normalized(vector);
  });
}

/** The mean of a Document's Passage vectors, normalised; null with none. */
export function meanVector(vectors: readonly Float32Array[]): Float32Array | null {
  const first = vectors[0];
  if (!first) return null;
  const mean = new Float32Array(first.length);
  for (const vector of vectors) {
    if (vector.length !== mean.length) continue;
    for (let index = 0; index < mean.length; index++)
      mean[index] = (mean[index] ?? 0) + (vector[index] ?? 0);
  }
  return normalized(mean);
}

// --- Clusters -----------------------------------------------------------------------------

export interface Clustering {
  /** Each vector's cluster. */
  assignment: number[];
  /** Each cluster's normalised centre. */
  centres: Float32Array[];
}

const nearestOf = (vector: Float32Array, centres: readonly Float32Array[]) => {
  let best = 0;
  let bestSimilarity = Number.NEGATIVE_INFINITY;
  centres.forEach((centre, index) => {
    const similarity = dot(vector, centre);
    if (similarity > bestSimilarity) {
      best = index;
      bestSimilarity = similarity;
    }
  });
  return best;
};

function centresOf(
  vectors: readonly Float32Array[],
  assignment: readonly number[],
  k: number,
): Float32Array[] {
  const dimensions = vectors[0]?.length ?? 0;
  const sums = Array.from({ length: k }, () => new Float32Array(dimensions));
  vectors.forEach((vector, at) => {
    const sum = sums[assignment[at] ?? 0];
    if (!sum) return;
    for (let index = 0; index < dimensions; index++)
      sum[index] = (sum[index] ?? 0) + (vector[index] ?? 0);
  });
  return sums.map(normalized);
}

function kmeansOnce(vectors: readonly Float32Array[], k: number, next: () => number): Clustering {
  const first = vectors[Math.floor(next() * vectors.length)] as Float32Array;
  const centres: Float32Array[] = [Float32Array.from(first)];
  // k-means++: each next centre far from those chosen, with odds by the squared distance.
  const distance = vectors.map((vector) => Math.max(0, 1 - dot(vector, first)));
  while (centres.length < k) {
    const weights = distance.map((each) => each * each);
    const total = weights.reduce((sum, each) => sum + each, 0);
    let pick = 0;
    if (total > 0) {
      let target = next() * total;
      while (pick < weights.length - 1 && target >= (weights[pick] ?? 0)) {
        target -= weights[pick] ?? 0;
        pick++;
      }
    } else {
      pick = Math.floor(next() * vectors.length);
    }
    const centre = Float32Array.from(vectors[pick] as Float32Array);
    centres.push(centre);
    vectors.forEach((vector, at) => {
      distance[at] = Math.min(distance[at] ?? 0, Math.max(0, 1 - dot(vector, centre)));
    });
  }
  let assignment = vectors.map((vector) => nearestOf(vector, centres));
  for (let round = 0; round < 40; round++) {
    const moved = centresOf(vectors, assignment, k);
    // A cluster left empty takes the vector farthest from its own centre.
    for (let cluster = 0; cluster < k; cluster++) {
      if (assignment.includes(cluster)) continue;
      let farthest = 0;
      let lowest = Number.POSITIVE_INFINITY;
      vectors.forEach((vector, at) => {
        const similarity = dot(vector, moved[assignment[at] ?? 0] as Float32Array);
        if (similarity < lowest) {
          lowest = similarity;
          farthest = at;
        }
      });
      moved[cluster] = Float32Array.from(vectors[farthest] as Float32Array);
      assignment[farthest] = cluster;
    }
    const next = vectors.map((vector) => nearestOf(vector, moved));
    const settled = next.every((cluster, at) => cluster === assignment[at]);
    assignment = next;
    centres.splice(0, centres.length, ...moved);
    if (settled) break;
  }
  return { assignment, centres: centresOf(vectors, assignment, k) };
}

const cohesion = (vectors: readonly Float32Array[], clustering: Clustering) =>
  vectors.reduce(
    (sum, vector, at) =>
      sum + dot(vector, clustering.centres[clustering.assignment[at] ?? 0] as Float32Array),
    0,
  );

/** Spherical k-means, the most cohesive of a few seeded starts. */
export function kmeans(vectors: readonly Float32Array[], k: number, seed = 1): Clustering {
  if (k <= 1 || vectors.length <= k)
    return k <= 1
      ? { assignment: vectors.map(() => 0), centres: centresOf(vectors, [], 1) }
      : {
          assignment: vectors.map((_, at) => at),
          centres: vectors.map((v) => Float32Array.from(v)),
        };
  const next = random(seed);
  let best: Clustering | null = null;
  let bestCohesion = Number.NEGATIVE_INFINITY;
  for (let start = 0; start < 3; start++) {
    const clustering = kmeansOnce(vectors, k, next);
    const score = cohesion(vectors, clustering);
    if (score > bestCohesion) {
      best = clustering;
      bestCohesion = score;
    }
  }
  return best as Clustering;
}

/**
 * The silhouette of a vector in its centroid form: how much nearer it is its own centre than
 * the nearest of `others`, from -1 to 1; 1 with no other.
 */
export function silhouette(
  vector: Float32Array,
  own: Float32Array,
  others: readonly Float32Array[],
): number {
  if (others.length === 0) return 1;
  const a = 1 - dot(vector, own);
  const b = Math.min(...others.map((centre) => 1 - dot(vector, centre)));
  const most = Math.max(a, b);
  return most <= 0 ? 0 : (b - a) / most;
}

/** The mean silhouette; a cluster of one counts 0, as in the usual silhouette, so outliers aren't split off. */
export function meanSilhouette(vectors: readonly Float32Array[], clustering: Clustering): number {
  const sizes = new Map<number, number>();
  for (const cluster of clustering.assignment) sizes.set(cluster, (sizes.get(cluster) ?? 0) + 1);
  return (
    vectors.reduce((sum, vector, at) => {
      const own = clustering.assignment[at] ?? 0;
      if ((sizes.get(own) ?? 0) <= 1) return sum;
      return (
        sum +
        silhouette(
          vector,
          clustering.centres[own] as Float32Array,
          clustering.centres.filter((_, index) => index !== own),
        )
      );
    }, 0) / Math.max(1, vectors.length)
  );
}

/** The clustering, with k from `min` to `max`, whose mean silhouette is highest. */
export function bestClustering(
  vectors: readonly Float32Array[],
  min: number,
  max: number,
): Clustering & { k: number } {
  let best: (Clustering & { k: number; score: number }) | null = null;
  for (let k = min; k <= max; k++) {
    const clustering = kmeans(vectors, k);
    const score = meanSilhouette(vectors, clustering);
    if (!best || score > best.score) best = { ...clustering, k, score };
  }
  if (!best) return { ...kmeans(vectors, 1), k: 1 };
  return { assignment: best.assignment, centres: best.centres, k: best.k };
}

/**
 * Splits a Folder's vectors into `SUBFOLDERS` clusters of at least `MIN_SUBFOLDER`, as many as
 * fit best by the mean silhouette; null when fewer than two hold enough. A cluster too small is
 * dissolved into the nearest one left.
 */
export function subclusters(vectors: readonly Float32Array[]): Clustering | null {
  let best: { clustering: Clustering; score: number } | null = null;
  const most = Math.min(SUBFOLDERS.max, Math.floor(vectors.length / MIN_SUBFOLDER));
  for (let k = SUBFOLDERS.min; k <= most; k++) {
    const clustering = withMinimum(vectors, kmeans(vectors, k), MIN_SUBFOLDER);
    if (clustering.centres.length < SUBFOLDERS.min) continue;
    const score = meanSilhouette(vectors, clustering);
    if (!best || score > best.score) best = { clustering, score };
  }
  return best?.clustering ?? null;
}

/** Dissolves the smallest cluster under `minimum` into the nearest others, until none is. */
export function withMinimum(
  vectors: readonly Float32Array[],
  clustering: Clustering,
  minimum: number,
): Clustering {
  let { assignment, centres } = clustering;
  for (;;) {
    const sizes = centres.map((_, cluster) => assignment.filter((each) => each === cluster).length);
    const smallest = sizes.indexOf(Math.min(...sizes));
    if (centres.length <= 1 || (sizes[smallest] ?? 0) >= minimum) break;
    const kept = centres.filter((_, cluster) => cluster !== smallest);
    assignment = vectors.map((vector, at) =>
      assignment[at] === smallest
        ? nearestOf(vector, kept)
        : (assignment[at] ?? 0) - ((assignment[at] ?? 0) > smallest ? 1 : 0),
    );
    centres = centresOf(vectors, assignment, kept.length);
  }
  return { assignment, centres };
}

/** Of each cluster's members, the `count` nearest its centre, nearest first. */
export function nearestMembers(
  vectors: readonly Float32Array[],
  clustering: Clustering,
  count: number,
): number[][] {
  return clustering.centres.map((centre, cluster) =>
    vectors
      .map((vector, at) => ({ at, similarity: dot(vector, centre) }))
      .filter(({ at }) => clustering.assignment[at] === cluster)
      .sort((a, b) => b.similarity - a.similarity || a.at - b.at)
      .slice(0, count)
      .map(({ at }) => at),
  );
}

// --- The plan -----------------------------------------------------------------------------

/** What the model is shown of a Document: its name, type and the start of its text. */
export interface PlanExcerpt {
  ref: string;
  name: string;
  type: string;
  text: string;
}

/** A Folder the model may put Documents in. */
export interface PlanFolder {
  id: string;
  name: string;
  description: string;
}

/** The Folders a sample is sorted into: one the User has (`id`), or a new one by name. */
export interface SortedFolder {
  id: string | null;
  name: string;
  description: string;
  /** The refs of the sampled Documents it holds. */
  refs: string[];
}

export interface SortRequest {
  documents: readonly PlanExcerpt[];
  folders: readonly PlanFolder[];
  language: Language;
  /** Organize This Folder: the Folder's name, whose subfolders these are. */
  within: string | null;
  aim: FolderAim;
}

export interface SubfolderGroup {
  ref: string;
  /** The name of the Folder it would be made in. */
  parent: string;
  documents: PlanExcerpt[];
}

/**
 * The requests a plan makes. Each sends only the Documents' names and the start of their text,
 * as the classification flow says, and the Folders' names and descriptions.
 */
export interface PlanModel {
  /** Proposes Folders for a sample, the User's own first, and puts each sampled Document in one or none. */
  sort(request: SortRequest, signal: AbortSignal): Promise<SortedFolder[]>;
  /** Each Document's Folder, by id, or null for none. */
  place(
    documents: readonly PlanExcerpt[],
    folders: readonly PlanFolder[],
    signal: AbortSignal,
  ): Promise<Map<string, string | null>>;
  /** A name and description for each group, by ref. */
  nameSubfolders(
    groups: readonly SubfolderGroup[],
    language: Language,
    signal: AbortSignal,
  ): Promise<Map<string, { name: string; description: string }>>;
}

export interface PlanInput {
  /** The readable Documents to place, each with its vector. */
  documents: readonly { id: string; vector: Float32Array }[];
  excerptOf(id: string): Omit<PlanExcerpt, "ref">;
  /** The Folders a Document may go into besides new ones. */
  folders: readonly PlanFolder[];
  language: Language;
  /** Organize This Folder: the Folder's name. Its new Folders are subfolders of it. */
  within: string | null;
  /** `AIM` when left out. */
  aim?: FolderAim;
}

/** Where a Document goes: a Folder there is, a new Folder (by key), or none. */
export type PlanPlace =
  | { kind: "folder"; folderId: string }
  | { kind: "new"; key: string }
  | { kind: "none"; unreachable?: true };

export interface PlannedFolder {
  key: string;
  name: string;
  description: string;
  /** The key of the new Folder it is a subfolder of. */
  parentKey: string | null;
}

export interface LibraryPlan {
  folders: PlannedFolder[];
  places: Map<string, PlanPlace>;
  /** The local clusters, and how many Documents the model saw or placed. */
  clusters: number;
  sampled: number;
  placedByModel: number;
  requests: number;
}

/** A request the plan will make, sized for an estimate before it sends anything. */
export interface PlanRequest {
  inputTokens: number;
  outputTokens: number;
}

/** The part of a plan made on this computer: the clusters and the sample. */
export interface LocalPlan {
  input: PlanInput;
  vectors: Float32Array[];
  clustering: Clustering;
  /** Indexes into `input.documents`, in the order they are sent. */
  sample: number[];
  /** The requests it makes at most: the sort, every other Document placed, the subfolders named. */
  requests(tokensOf: (text: string) => number): PlanRequest[];
}

/** Clusters the Documents and picks the sample (steps 1–3), with nothing sent. */
export function planLocally(input: PlanInput): LocalPlan {
  const vectors = centred(input.documents.map((each) => each.vector));
  const count = vectors.length;
  const most = Math.min(CLUSTERS.max, Math.floor(count / 5));
  const clustering =
    count <= SAMPLE || most < CLUSTERS.min
      ? kmeans(vectors, 1)
      : bestClustering(vectors, CLUSTERS.min, most);
  const sample =
    count <= SAMPLE
      ? vectors.map((_, at) => at)
      : spread(nearestMembers(vectors, clustering, count), SAMPLE);
  return {
    input,
    vectors,
    clustering,
    sample,
    requests(tokensOf) {
      const excerptTokens = (at: number) => {
        const doc = input.documents[at];
        if (!doc) return 0;
        const excerpt = input.excerptOf(doc.id);
        return tokensOf(`${excerpt.name} ${excerpt.type} ${excerpt.text}`) + 12;
      };
      const folderTokens = input.folders.reduce(
        (sum, folder) => sum + tokensOf(`${folder.name} ${folder.description}`) + 8,
        0,
      );
      const sampled = sample.reduce((sum, at) => sum + excerptTokens(at), 0);
      const each = sample.length ? sampled / sample.length : 0;
      const rest = count - sample.length;
      const requests: PlanRequest[] = [
        {
          inputTokens: Math.ceil(sampled + folderTokens + INSTRUCTION_TOKENS),
          outputTokens: 600 + sample.length * 6,
        },
      ];
      const plannedFolders = folderTokens + 7 * 40;
      for (let left = rest; left > 0; left -= PLACE_BATCH) {
        const size = Math.min(PLACE_BATCH, left);
        requests.push({
          inputTokens: Math.ceil(size * each + plannedFolders + INSTRUCTION_TOKENS),
          outputTokens: size * 16,
        });
      }
      if (count > SPLIT_OVER)
        requests.push({
          inputTokens: Math.ceil(
            Math.min(7, Math.floor(count / SPLIT_OVER)) * SUBFOLDERS.max * SUBFOLDER_SAMPLE * each +
              INSTRUCTION_TOKENS,
          ),
          outputTokens: 7 * SUBFOLDERS.max * 40,
        });
      return requests;
    },
  };
}

/** About what a request's instructions take. */
const INSTRUCTION_TOKENS = 450;

/** `total` of the members, taking each cluster's next in turn, so every cluster is seen. */
function spread(members: readonly number[][], total: number): number[] {
  const out: number[] = [];
  for (let round = 0; out.length < total; round++) {
    let took = false;
    for (const cluster of members) {
      const at = cluster[round];
      if (at === undefined) continue;
      out.push(at);
      took = true;
      if (out.length === total) break;
    }
    if (!took) break;
  }
  return out;
}

const refOf = (at: number) => `d${at + 1}`;

/** Runs a list of tasks, `width` at a time. */
async function inTurn<T>(tasks: readonly (() => Promise<T>)[], width: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, tasks.length) }, async () => {
      while (next < tasks.length) {
        const at = next++;
        results[at] = await (tasks[at] as () => Promise<T>)();
      }
    }),
  );
  return results;
}

export interface PlanCallbacks {
  model: PlanModel;
  signal: AbortSignal;
  /** How many of the Documents have their place so far. */
  progress(done: number): void;
  /**
   * Whether a failed placement request leaves its Documents out as unreachable (true) or ends
   * the plan (false): a stop by the User or the send gate always ends it.
   */
  leavesOut(error: unknown): boolean;
}

/** Steps 3–6: the requests, and every Document's place. */
export async function finishPlan(local: LocalPlan, run: PlanCallbacks): Promise<LibraryPlan> {
  const { input, vectors, clustering, sample } = local;
  const { model, signal } = run;
  const documents = input.documents;
  const excerpt = (at: number): PlanExcerpt => ({
    ref: refOf(at),
    ...input.excerptOf((documents[at] as { id: string }).id),
  });
  let requests = 0;
  const askedOne = new Set<number>();
  const places = new Map<number, PlanPlace>();
  const report = () => run.progress(places.size);
  if (documents.length === 0)
    return { folders: [], places: new Map(), clusters: 0, sampled: 0, placedByModel: 0, requests };

  const aim = {
    least: Math.max(AIM.least, Math.min(input.aim?.least ?? AIM.least, MOST_NEW)),
    most: Math.max(AIM.least, Math.min(input.aim?.most ?? AIM.most, MOST_NEW)),
  };
  // The Folders there are go to the model as F1, F2…; new ones are N1, N2… in the plan.
  const known = input.folders.map((folder, at) => ({ ...folder, ref: `F${at + 1}` }));
  const folders: PlannedFolder[] = [];
  const choices = (): PlanFolder[] => [
    ...known.map(({ ref, name, description }) => ({ id: ref, name, description })),
    ...folders.map(({ key, name, description }) => ({ id: key, name, description })),
  ];
  const placeOf = (choice: string | null): PlanPlace => {
    const existing = known.find((each) => each.ref === choice);
    if (existing) return { kind: "folder", folderId: existing.id };
    return folders.some((folder) => folder.key === choice)
      ? { kind: "new", key: choice as string }
      : { kind: "none" };
  };

  /**
   * Has the model sort these, beside the Folders so far, and places them. Past `aim.most` new
   * Folders, the ones holding the fewest go; their Documents are returned to be placed again.
   */
  const sortInto = async (shown: readonly number[]): Promise<number[]> => {
    const sorted = await model.sort(
      {
        documents: shown.map(excerpt),
        folders: choices(),
        language: input.language,
        within: input.within,
        aim,
      },
      signal,
    );
    requests++;
    const shownAt = new Map(shown.map((at) => [refOf(at), at]));
    const room = aim.most - folders.length;
    const fresh = sorted.filter(
      (folder) => folder.id === null || placeOf(folder.id).kind === "none",
    );
    const dropped = new Set(
      [...fresh].sort((a, b) => b.refs.length - a.refs.length).slice(Math.max(0, room)),
    );
    const again: number[] = [];
    for (const folder of sorted) {
      const ats = folder.refs.flatMap((ref) => {
        const at = shownAt.get(ref);
        return at === undefined || places.has(at) || again.includes(at) ? [] : [at];
      });
      if (dropped.has(folder)) {
        again.push(...ats);
        continue;
      }
      let place = folder.id === null ? null : placeOf(folder.id);
      if (!place || place.kind === "none") {
        const key = `N${folders.length + 1}`;
        folders.push({ key, name: folder.name, description: folder.description, parentKey: null });
        place = { kind: "new", key };
      }
      for (const at of ats) places.set(at, place);
    }
    for (const at of shown)
      if (!places.has(at) && !again.includes(at)) places.set(at, { kind: "none" });
    report();
    return again;
  };

  /** Asks the model where each of these goes, `PLACE_BATCH` to a request. */
  const placeAll = async (asked: readonly number[]) => {
    for (const at of asked) askedOne.add(at);
    const batches: number[][] = [];
    for (let start = 0; start < asked.length; start += PLACE_BATCH)
      batches.push(asked.slice(start, start + PLACE_BATCH));
    await inTurn(
      batches.map((batch) => async () => {
        try {
          const chosen = await model.place(batch.map(excerpt), choices(), signal);
          requests++;
          for (const at of batch) places.set(at, placeOf(chosen.get(refOf(at)) ?? null));
        } catch (error) {
          if (signal.aborted || !run.leavesOut(error)) throw error;
          requests++;
          for (const at of batch) places.set(at, { kind: "none", unreachable: true });
        }
        report();
      }),
      PLACING_AT_ONCE,
    );
  };

  const unclear = await sortInto(sample);

  // A cluster goes where its sampled Documents all went; a split cluster goes nowhere. Only the
  // model leaves a Document out.
  const keyOf = (place: PlanPlace | undefined) =>
    !place
      ? "again"
      : place.kind === "folder"
        ? `F:${place.folderId}`
        : place.kind === "new"
          ? place.key
          : "none";
  const clusterPlace = clustering.centres.map((_, cluster): PlanPlace | null => {
    const went = sample
      .filter((at) => clustering.assignment[at] === cluster)
      .map((at) => places.get(at));
    const first = went[0];
    return first && first.kind !== "none" && went.every((each) => keyOf(each) === keyOf(first))
      ? first
      : null;
  });
  documents.forEach((_, at) => {
    if (places.has(at) || unclear.includes(at)) return;
    const own = clustering.assignment[at] ?? 0;
    const place = clusterPlace[own];
    if (!place) {
      unclear.push(at);
      return;
    }
    const elsewhere = clustering.centres.filter((_, cluster) => {
      const other = clusterPlace[cluster];
      return cluster !== own && (!other || keyOf(other) !== keyOf(place));
    });
    const vector = vectors[at] as Float32Array;
    // The sampled Document most like it went elsewhere: its cluster mixes what the model told apart.
    let nearest = -1;
    let nearestSimilarity = Number.NEGATIVE_INFINITY;
    for (const sampled of sample) {
      const similarity = dot(vector, vectors[sampled] as Float32Array);
      if (similarity > nearestSimilarity) {
        nearest = sampled;
        nearestSimilarity = similarity;
      }
    }
    if (
      silhouette(vector, clustering.centres[own] as Float32Array, elsewhere) < CLEAR ||
      keyOf(places.get(nearest)) !== keyOf(place)
    )
      unclear.push(at);
    else places.set(at, place);
  });
  report();
  await placeAll(unclear);

  // Documents the model left out of every Folder it had, though it never saw them in a sample:
  // a second look may find an area 3 or more of them share.
  const seen = new Set(sample);
  const leftOut = [...places]
    .filter(([at, place]) => place.kind === "none" && !place.unreachable && !seen.has(at))
    .map(([at]) => at);
  if (leftOut.length >= MIN_FOLDER && folders.length < aim.most) {
    const byCluster = clustering.centres.map((_, cluster) =>
      leftOut.filter((at) => clustering.assignment[at] === cluster),
    );
    const second = spread(byCluster, SAMPLE);
    for (const at of second) places.delete(at);
    const before = folders.length;
    const again = await sortInto(second);
    // With a Folder more, every Document still left out is placed again, those sampled first too.
    const rest = [...places]
      .filter(([at, place]) => place.kind === "none" && !place.unreachable && !second.includes(at))
      .map(([at]) => at);
    await placeAll([...again, ...(folders.length > before ? rest : [])]);
  }

  // A new Folder with too few Documents isn't made: they are left out.
  const holding = (key: string) =>
    [...places.values()].filter((place) => place.kind === "new" && place.key === key).length;
  const kept = folders.filter((folder) => holding(folder.key) >= MIN_FOLDER);
  for (const [at, place] of places)
    if (place.kind === "new" && !kept.some((folder) => folder.key === place.key))
      places.set(at, { kind: "none" });

  const subfolders = await split(
    kept,
    input.folders.map((folder) => folder.name),
    places,
    vectors,
    excerpt,
    model,
    input.language,
    signal,
  );
  if (subfolders.requested) requests++;

  return {
    folders: [...kept, ...subfolders.folders],
    places: new Map(
      [...places].map(([at, place]) => [(documents[at] as { id: string }).id, place]),
    ),
    clusters: clustering.centres.length,
    sampled: sample.length,
    placedByModel: askedOne.size,
    requests,
  };
}

/** Step 6: subfolders for each new Folder of more than `SPLIT_OVER`, named in one request. */
async function split(
  folders: readonly PlannedFolder[],
  existing: readonly string[],
  places: Map<number, PlanPlace>,
  vectors: readonly Float32Array[],
  excerpt: (at: number) => PlanExcerpt,
  model: PlanModel,
  language: Language,
  signal: AbortSignal,
): Promise<{ folders: PlannedFolder[]; requested: boolean }> {
  const splits: { parent: PlannedFolder; members: number[]; clustering: Clustering }[] = [];
  for (const parent of folders) {
    const members = [...places]
      .filter(([, place]) => place.kind === "new" && place.key === parent.key)
      .map(([at]) => at);
    if (members.length <= SPLIT_OVER) continue;
    const clustering = subclusters(members.map((at) => vectors[at] as Float32Array));
    if (clustering) splits.push({ parent, members, clustering });
  }
  if (splits.length === 0) return { folders: [], requested: false };
  const groups: SubfolderGroup[] = [];
  for (const [index, { parent, members, clustering }] of splits.entries()) {
    const nearest = nearestMembers(
      members.map((at) => vectors[at] as Float32Array),
      clustering,
      SUBFOLDER_SAMPLE,
    );
    for (const [sub, cluster] of nearest.entries())
      groups.push({
        ref: `S${index + 1}.${sub + 1}`,
        parent: parent.name,
        documents: cluster.map((each) => excerpt(members[each] as number)),
      });
  }
  const names = await model.nameSubfolders(groups, language, signal);
  const made: PlannedFolder[] = [];
  // Folder names are the Library's to keep apart, wherever the Folder is.
  const taken = new Set(
    [
      ...existing.map((name) => name.split(" › ").at(-1) ?? name),
      ...folders.map((f) => f.name),
    ].map((name) => name.trim().toLowerCase()),
  );
  for (const [index, { parent, members, clustering }] of splits.entries()) {
    // Groups the model named alike are one subfolder.
    const byName = new Map<string, { name: string; description: string; subs: number[] }>();
    clustering.centres.forEach((_, sub) => {
      const named = names.get(`S${index + 1}.${sub + 1}`);
      if (!named) return;
      const key = named.name.trim().toLowerCase();
      const entry = byName.get(key) ?? { ...named, subs: [] };
      entry.subs.push(sub);
      byName.set(key, entry);
    });
    const sizes = [...byName.values()].map(
      (entry) =>
        members.filter((_, each) => entry.subs.includes(clustering.assignment[each] ?? -1)).length,
    );
    const named = [...byName.values()].filter(
      (entry) => !taken.has(entry.name.trim().toLowerCase()),
    );
    if (
      byName.size < SUBFOLDERS.min ||
      named.length !== byName.size ||
      sizes.some((size) => size < MIN_SUBFOLDER) ||
      sizes.reduce((sum, size) => sum + size, 0) !== members.length
    )
      continue;
    for (const entry of named) {
      taken.add(entry.name.trim().toLowerCase());
      const key = `${parent.key}.${made.length + 1}`;
      made.push({ key, name: entry.name, description: entry.description, parentKey: parent.key });
      members.forEach((at, each) => {
        if (entry.subs.includes(clustering.assignment[each] ?? -1))
          places.set(at, { kind: "new", key });
      });
    }
  }
  return { folders: made, requested: true };
}
