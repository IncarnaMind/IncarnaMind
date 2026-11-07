/**
 * Organize planned from the whole Library at any size (#1569): local clusters, a fixed sample to
 * the model, placement by cluster where it is clear, and the plan written into the Review. The
 * plan's steps with synthetic vectors and a scripted model; the run through the core's public
 * interface, as the Library uses it.
 */
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import {
  type Core,
  DATABASE_FILE,
  type OrganizeProgress,
  type SaveChatProviderInput,
} from "../../src/core";
import { approximateTokens } from "../../src/core/documents/passages";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import type { GroupClassifier } from "../../src/core/library/classifier";
import { createLibraryOrganizer } from "../../src/core/library/organizeLibrary";
import {
  aimAfter,
  bestClustering,
  type FolderAim,
  finishPlan,
  type LibraryPlan,
  type PlanExcerpt,
  type PlanModel,
  planLocally,
  SAMPLE,
  type SubfolderGroup,
  subclusters,
  wordVectors,
} from "../../src/core/library/plan";
import { createOrganizeReviewStore } from "../../src/core/organizeReview";
import { openDatabase } from "../../src/core/storage";
import { PRESET_TAGS } from "../../src/core/tags/presets";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { turnOnEmbeddings } from "../helpers/embedding";
import { scriptedModels } from "../helpers/models";

// --- Synthetic vectors ---------------------------------------------------------------------

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const unit = (values: number[]) => {
  const length = Math.hypot(...values);
  return Float32Array.from(values.map((value) => value / length));
};

/** `count` vectors around each centre: a tight group per centre. */
function groups(centres: number, count: number, dimensions = 24, spread = 0.12, seed = 3) {
  const next = seeded(seed);
  const middles = Array.from({ length: centres }, () =>
    unit(Array.from({ length: dimensions }, () => next() * 2 - 1)),
  );
  const around = (middle: Float32Array) =>
    unit([...middle].map((value) => value + (next() * 2 - 1) * spread));
  return {
    middles,
    vectors: middles.flatMap((middle) => Array.from({ length: count }, () => around(middle))),
  };
}

const LETTERS = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota"];

/**
 * A plan model that files a Document by the first letter of its name ("A12" in Alpha), names
 * subfolders by its second, and records what each request was given.
 */
function letterModel(
  options: {
    failPlacing?: boolean;
    existing?: Record<string, string>;
    missesAtFirst?: string;
  } = {},
) {
  const asked = {
    sorted: [] as PlanExcerpt[][],
    placed: [] as PlanExcerpt[][],
    named: [] as SubfolderGroup[][],
  };
  const model: PlanModel = {
    async sort(request) {
      asked.sorted.push([...request.documents]);
      const folders = new Map<string, { id: string | null; name: string; refs: string[] }>();
      for (const doc of request.documents) {
        const name = LETTERS.find((each) => each.startsWith(doc.name.charAt(0)));
        if (!name || (asked.sorted.length === 1 && name === options.missesAtFirst)) continue;
        const existing =
          request.folders.find((folder) => folder.name === name)?.id ??
          options.existing?.[name] ??
          null;
        const entry = folders.get(name) ?? { id: existing, name, refs: [] };
        entry.refs.push(doc.ref);
        folders.set(name, entry);
      }
      return [...folders.values()].map((each) => ({ ...each, description: `About ${each.name}` }));
    },
    async place(documents, folders) {
      asked.placed.push([...documents]);
      if (options.failPlacing)
        throw new APICallError({
          message: "fetch failed",
          url: "https://api.example.com",
          requestBodyValues: {},
          isRetryable: false,
        });
      return new Map(
        documents.map((doc) => [
          doc.ref,
          folders.find((folder) => folder.name.startsWith(doc.name.charAt(0)))?.id ?? null,
        ]),
      );
    },
    async nameSubfolders(groups) {
      asked.named.push([...groups]);
      return new Map(
        groups.map((group) => [
          group.ref,
          { name: `Part ${group.documents[0]?.name.charAt(1)}`, description: "" },
        ]),
      );
    },
  };
  return { model, asked };
}

function plan(
  named: { name: string; vector: Float32Array }[],
  model: PlanModel,
  folders: { id: string; name: string; description: string }[] = [],
  leavesOut = () => true,
  aim?: FolderAim,
): Promise<LibraryPlan> {
  const local = planLocally({
    documents: named.map((each, at) => ({ id: `doc${at}`, vector: each.vector })),
    excerptOf: (id) => ({
      name: named[Number(id.slice(3))]?.name ?? "",
      type: "plain text",
      text: "",
    }),
    folders,
    language: "en",
    within: null,
    ...(aim && { aim }),
  });
  return finishPlan(local, {
    model,
    signal: new AbortController().signal,
    progress: () => {},
    leavesOut,
  });
}

const namedGroups = (vectors: Float32Array[], perGroup: number, prefixes: string[]) =>
  vectors.map((vector, at) => ({
    name: `${prefixes[Math.floor(at / perGroup)]}${at}`,
    vector,
  }));

describe("The plan's local steps", () => {
  test("k is the one from 3 to 12 with the highest mean silhouette", () => {
    const { vectors } = groups(5, 12);
    const clustering = bestClustering(vectors, 3, 12);
    expect(clustering.k).toBe(5);
    for (let group = 0; group < 5; group++) {
      const clusters = new Set(clustering.assignment.slice(group * 12, group * 12 + 12));
      expect(clusters.size).toBe(1);
    }
  });

  test("a Folder's subclusters: 2 to 5 of at least 5 each, a few outliers joined to the nearest", () => {
    const two = groups(2, 25, 24, 0.12, 5).vectors;
    const outliers = groups(1, 3, 24, 0.12, 11).vectors;
    const split = subclusters([...two, ...outliers]);
    expect(split?.centres).toHaveLength(2);
    const sizes = [0, 1].map(
      (cluster) => split?.assignment.filter((each) => each === cluster).length,
    );
    expect(sizes.every((size) => (size ?? 0) >= 5)).toBe(true);
    expect(subclusters(groups(2, 4).vectors)).toBeNull();
  });

  test("word vectors: Documents sharing words come together, Chinese read as character pairs", () => {
    const [lease, lease2, minutes, zhLease, zhLease2] = wordVectors([
      "Lease of the warehouse: rent, deposit and term of the lease.",
      "Lease renewal: the rent and the deposit for a further term.",
      "Board minutes: attendees, agenda and actions agreed.",
      "租赁合同：租金、押金和租期。",
      "续租合同：租金与押金，租期延长。",
    ]).map((vector) => vector as Float32Array);
    const similarity = (a: Float32Array, b: Float32Array) =>
      a.reduce((sum, value, at) => sum + value * (b[at] ?? 0), 0);
    if (!lease || !lease2 || !minutes || !zhLease || !zhLease2) throw new Error("Five vectors.");
    expect(similarity(lease, lease2)).toBeGreaterThan(similarity(lease, minutes));
    expect(similarity(zhLease, zhLease2)).toBeGreaterThan(similarity(zhLease, minutes));
  });

  test("Fewer and More Folders aim one or two from the last plan's count, still 3 to 7", () => {
    expect(aimAfter(null)).toEqual({ least: 3, most: 7 });
    expect(aimAfter({ fewerThan: 5 })).toEqual({ least: 3, most: 4 });
    expect(aimAfter({ fewerThan: 3 })).toEqual({ least: 3, most: 3 });
    expect(aimAfter({ moreThan: 5 })).toEqual({ least: 6, most: 7 });
    expect(aimAfter({ moreThan: 7 })).toEqual({ least: 7, most: 7 });
  });
});

describe("The plan's requests and places", () => {
  test("the model sees a fixed sample however large the Library is, so planning stays flat", async () => {
    for (const each of [20, 100]) {
      const { model, asked } = letterModel();
      const { vectors } = groups(3, each);
      await plan(namedGroups(vectors, each, ["A", "B", "G"]), model);
      expect(asked.sorted[0]).toHaveLength(Math.min(SAMPLE, 3 * each));
    }
  });

  test("only a Document between two clusters that went to different Folders is asked of the model", async () => {
    const { model, asked } = letterModel();
    const { vectors, middles } = groups(3, 30);
    const [alpha, beta] = middles as [Float32Array, Float32Array];
    const between = unit([...alpha].map((value, at) => value + (beta[at] ?? 0)));
    const result = await plan(
      [...namedGroups(vectors, 30, ["A", "B", "G"]), { name: "AB", vector: between }],
      model,
    );
    expect(asked.placed.flat().map((doc) => doc.name)).toEqual(["AB"]);
    expect(result.placedByModel).toBe(1);
    expect(result.folders.map((folder) => folder.name).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
    const placeOf = (at: number) => result.places.get(`doc${at}`);
    const alphaKey = result.folders.find((folder) => folder.name === "Alpha")?.key;
    expect(placeOf(5)).toEqual({ kind: "new", key: alphaKey });
    expect(placeOf(90)).toEqual({ kind: "new", key: alphaKey });
  });

  test("a new Folder under 3 Documents isn't made, and at most 7 new ones are, or fewer when asked", async () => {
    const { model } = letterModel();
    const { vectors } = groups(9, 4, 32);
    const named = namedGroups(vectors, 4, ["A", "B", "G", "D", "E", "Z", "H", "T", "I"]);
    // Two of Iota's four are given to Alpha's names, leaving Iota two.
    const reshaped = named.map((each, at) => (at >= 34 ? { ...each, name: `A${at}` } : each));
    const result = await plan(reshaped, model);
    expect(result.folders.filter((folder) => folder.parentKey === null).length).toBeLessThanOrEqual(
      7,
    );
    const iota = [32, 33].map((at) => result.places.get(`doc${at}`));
    expect(iota).toEqual([{ kind: "none" }, { kind: "none" }]);
    for (const folder of result.folders) {
      const held = [...result.places.values()].filter(
        (place) => place.kind === "new" && place.key === folder.key,
      );
      expect(held.length).toBeGreaterThanOrEqual(3);
    }

    const fewer = await plan(reshaped, letterModel().model, [], () => true, { least: 3, most: 4 });
    const top = fewer.folders.filter((folder) => folder.parentKey === null);
    expect(top.length).toBeLessThanOrEqual(4);
    expect(top.map((folder) => folder.name)).toContain("Alpha");
  });

  test("a new Folder of more than 40 is split into named subfolders of at least 5", async () => {
    const { model, asked } = letterModel();
    const parts = groups(2, 25, 24, 0.1, 9).vectors;
    const beta = groups(1, 6, 24, 0.1, 13).vectors;
    const named = [
      ...parts.map((vector, at) => ({ name: `A${at < 25 ? "x" : "y"}${at}`, vector })),
      ...beta.map((vector, at) => ({ name: `B${at}`, vector })),
    ];
    const result = await plan(named, model);
    const alpha = result.folders.find((folder) => folder.name === "Alpha");
    const subfolders = result.folders.filter((folder) => folder.parentKey === alpha?.key);
    expect(subfolders.map((folder) => folder.name).sort()).toEqual(["Part x", "Part y"]);
    expect(asked.named).toHaveLength(1);
    for (const sub of subfolders) {
      const held = [...result.places].filter(
        ([, place]) => place.kind === "new" && place.key === sub.key,
      );
      expect(held).toHaveLength(25);
    }
    expect(result.folders.find((folder) => folder.name === "Beta")?.parentKey).toBeNull();
  });

  test("a cluster the model put in a Folder the User has, a subfolder too, goes there", async () => {
    const { model } = letterModel({ existing: { Alpha: "F1" } });
    const { vectors } = groups(3, 20);
    const result = await plan(namedGroups(vectors, 20, ["A", "B", "G"]), model, [
      { id: "leases-id", name: "Contracts › Leases", description: "Leases" },
    ]);
    expect(result.places.get("doc0")).toEqual({ kind: "folder", folderId: "leases-id" });
    expect(result.places.get("doc19")).toEqual({ kind: "folder", folderId: "leases-id" });
    expect(result.folders.map((folder) => folder.name)).not.toContain("Alpha");
  });

  test("3 or more Documents left out of every Folder get a second look, which may find their own", async () => {
    const { model, asked } = letterModel({ missesAtFirst: "Delta" });
    const { vectors } = groups(4, 20);
    const result = await plan(namedGroups(vectors, 20, ["A", "B", "G", "D"]), model);
    expect(asked.sorted).toHaveLength(2);
    expect(asked.sorted[1]?.every((doc) => doc.name.startsWith("D"))).toBe(true);
    const delta = result.folders.find((folder) => folder.name === "Delta");
    for (let at = 60; at < 80; at++)
      expect(result.places.get(`doc${at}`)).toEqual({ kind: "new", key: delta?.key });
  });

  test("a placement request that can't reach the service leaves its Documents out, or ends the plan", async () => {
    const { vectors, middles } = groups(3, 30);
    const [alpha, beta] = middles as [Float32Array, Float32Array];
    const named = [
      ...namedGroups(vectors, 30, ["A", "B", "G"]),
      { name: "AB", vector: unit([...alpha].map((value, at) => value + (beta[at] ?? 0))) },
    ];
    const result = await plan(named, letterModel({ failPlacing: true }).model);
    expect(result.places.get("doc90")).toEqual({ kind: "none", unreachable: true });
    await expect(
      plan(named, letterModel({ failPlacing: true }).model, [], () => false),
    ).rejects.toThrow("fetch failed");
  });
});

// --- Through the core -------------------------------------------------------------------------

const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };

const userText = (options: LanguageModelV4CallOptions) =>
  options.prompt
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n");

/** Which Folder a Document's words put it in, as the scripted model reads them. */
const RULES = [
  { word: "lease", folder: "Leases" },
  { word: "invoice", folder: "Invoices" },
  { word: "minutes", folder: "Meetings" },
  { word: "nda", folder: "NDAs" },
];

const ruleOf = (doc: { name: string; text: string }) =>
  RULES.find((rule) => `${doc.name} ${doc.text}`.toLowerCase().includes(rule.word));

/** A chat model that sorts by `RULES`, answering the plan's requests, and records each request. */
function rulesModel(options: { holdSort?: boolean } = {}) {
  const requests: string[] = [];
  const reply = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    warnings: [],
    usage: {
      inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
  });
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const schema = (
        call.responseFormat?.type === "json" ? call.responseFormat.schema : undefined
      ) as { properties?: Record<string, unknown> } | undefined;
      if (schema?.properties?.folders && "documents" in JSON.parse(userText(call))) {
        const text = userText(call);
        requests.push(text);
        if (options.holdSort)
          await new Promise((_, reject) =>
            call.abortSignal?.addEventListener("abort", () => reject(new Error("Stopped."))),
          );
        const data = JSON.parse(text) as {
          folders: { id: string; name: string }[];
          documents: { ref: string; name: string; text: string }[];
        };
        const folders = new Map<string, { key: string; name: string; description: string }>();
        const placed: { ref: string; folder: string }[] = [];
        for (const doc of data.documents) {
          const rule = ruleOf(doc);
          if (!rule) {
            placed.push({ ref: doc.ref, folder: "none" });
            continue;
          }
          const existing = data.folders.find((folder) => folder.name.endsWith(rule.folder));
          const key = existing?.id ?? `N${folders.size + 1}`;
          const entry = folders.get(rule.folder) ?? {
            key,
            name: existing ? "" : rule.folder,
            description: `Everything about ${rule.folder}`,
          };
          folders.set(rule.folder, entry);
          placed.push({ ref: doc.ref, folder: entry.key });
        }
        return reply({ folders: [...folders.values()], documents: placed });
      }
      if (schema?.properties?.placements) {
        const text = userText(call);
        requests.push(text);
        const data = JSON.parse(text) as {
          folders: { id: string; name: string }[];
          documents: { ref: string; name: string; text: string }[];
        };
        return reply({
          placements: data.documents.map((doc) => {
            const rule = ruleOf(doc);
            const folder = rule && data.folders.find((each) => each.name.endsWith(rule.folder));
            return { ref: doc.ref, folder: folder?.id ?? "none" };
          }),
        });
      }
      return reply({ tags: [], newTags: [] });
    },
  });
  return { model, requests };
}

async function start(options: { holdSort?: boolean; embeddings?: boolean } = {}) {
  const sorting = rulesModel(options);
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(sorting.model).createChatModel,
    ...(options.embeddings && { embedder: createFakeEmbedder({ delayMs: 40 }) }),
  });
  if (options.embeddings) await turnOnEmbeddings(core);
  const provider = await core.saveChatProvider(LOCAL);
  await core.saveLibrarySettings({
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: LOCAL.modelId } },
    automatic: false,
  });
  return { core, sorting, dataDir, sources: await createSourceFolder() };
}

async function add(core: Core, folder: string, files: Record<string, string>) {
  return addAndProcess(
    core,
    await Promise.all(
      Object.entries(files).map(([name, text]) => writeSourceFile(folder, name, text)),
    ),
  );
}

const placementsByName = async (core: Core) => {
  const names = new Map((await core.listDocuments()).map((doc) => [doc.id, doc.name]));
  const review = await core.getOrganizeReview();
  return {
    review,
    byName: new Map(review.items.map((item) => [names.get(item.documentId), item])),
  };
};

const LONG_TAIL = "PAST-THE-EXCERPT";

describe("Organize the Library into the Review", () => {
  test("proposes Folders, existing subfolders included, sending only names and the start of the text", async () => {
    const { core, sorting, sources } = await start();
    const contracts = await core.createLibraryGroup({
      name: "Contracts",
      description: "Agreements",
    });
    const leases = await core.createLibraryGroup({
      name: "Leases",
      description: "Signed leases",
      parentId: contracts.id,
    });
    const [filed] = await add(core, sources, { "Old lease.txt": "A lease the User filed." });
    if (!filed) throw new Error("Added.");
    await core.assignDocumentGroup(filed.id, leases.id);
    await add(core, sources, {
      "Lease A.txt": `Lease of unit 4. ${"Rent and deposit terms. ".repeat(120)}${LONG_TAIL}`,
      "Lease B.txt": "Lease of unit 5.",
      "Lease C.txt": "Lease renewal.",
      "Invoice 1.txt": "Invoice for March.",
      "Invoice 2.txt": "Invoice for April.",
      "Invoice 3.txt": "Invoice for May.",
      "Board minutes 1.txt": "Minutes of the board.",
      "Board minutes 2.txt": "Minutes of the second board.",
      "Board minutes 3.txt": "Minutes of the third board.",
      "Garden.txt": "Tomatoes and beans this year.",
    });
    const [scan] = await addAndProcess(core, [
      join(process.cwd(), "tests/fixtures/organize/files/scan_0042.pdf"),
    ]);
    expect(scan?.status).toBe("no-text");

    const result = await core.organizeLibrary();
    expect(result).toMatchObject({ status: "done", documents: 11 });

    const { review, byName } = await placementsByName(core);
    expect(byName.get("Lease A")?.placement).toEqual({ kind: "folder", folderId: leases.id });
    expect(byName.has("Old lease")).toBe(false);
    const folderOf = (name: string) => {
      const placement = byName.get(name)?.placement;
      return placement?.kind === "newFolder"
        ? review.folders.find((folder) => folder.id === placement.newFolderId)
        : undefined;
    };
    expect(folderOf("Invoice 2")).toMatchObject({ name: "Invoices", parentId: null });
    expect(folderOf("Board minutes 3")?.name).toBe("Meetings");
    expect(byName.get("Garden")?.placement).toEqual({
      kind: "leftOut",
      leftOut: { reason: "doesntFit" },
    });
    expect(byName.get("scan_0042")?.placement).toEqual({
      kind: "leftOut",
      leftOut: { reason: "noText" },
    });

    expect(sorting.requests).toHaveLength(1);
    const sent = sorting.requests.join("\n");
    expect(sent).toContain("Contracts › Leases");
    expect(sent).toContain("Lease of unit 4");
    expect(sent).not.toContain(LONG_TAIL);
    expect(sent).not.toContain("Old lease");
    expect(sent).not.toContain('"tags"');
    for (const preset of PRESET_TAGS) expect(sent).not.toContain(preset.text.en.description);
  });

  test("waits for Documents still being read, says how many, then plans them all", async () => {
    const { core, sources } = await start({ embeddings: true });
    const progress: OrganizeProgress[] = [];
    core.on("organize.progress", (each) => progress.push(each));
    const paths = await Promise.all(
      ["Lease 1", "Lease 2", "Lease 3"].map((name) =>
        writeSourceFile(sources, `${name}.txt`, `${name}: a lease of a unit, rent and deposit.`),
      ),
    );
    await core.addDocuments(paths);

    const result = await core.organizeLibrary();

    expect(progress.some((each) => each.waiting > 0)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ waiting: 0, done: 3, total: 3 });
    expect(result).toMatchObject({ status: "done", documents: 3, proposed: 3 });
    expect((await core.listDocuments()).every((doc) => doc.status === "ready")).toBe(true);
  });

  test("Organize This Folder: its own Documents into its subfolders and new ones, nothing out", async () => {
    const { core, sources } = await start();
    const contracts = await core.createLibraryGroup({
      name: "Contracts",
      description: "Agreements",
    });
    const leases = await core.createLibraryGroup({
      name: "Leases",
      description: "Signed leases",
      parentId: contracts.id,
    });
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money" });
    const inside = await add(core, sources, {
      "Lease 1.txt": "Lease of unit 1.",
      "NDA 1.txt": "Mutual NDA with Alder.",
      "NDA 2.txt": "NDA with Birch.",
      "NDA 3.txt": "NDA with Cedar.",
      "Letter.txt": "A letter about the weather.",
    });
    for (const doc of inside) await core.assignDocumentGroup(doc.id, contracts.id);
    const [elsewhere, unfiled] = await add(core, sources, {
      "Lease 9.txt": "Lease kept in Finance.",
      "Lease 10.txt": "Lease in no Folder.",
    });
    if (!elsewhere || !unfiled) throw new Error("Added.");
    await core.assignDocumentGroup(elsewhere.id, finance.id);

    const result = await core.organizeLibrary({ folderId: contracts.id });
    expect(result).toMatchObject({ status: "done", documents: 5 });

    const { review, byName } = await placementsByName(core);
    expect(byName.get("Lease 1")?.placement).toEqual({ kind: "folder", folderId: leases.id });
    expect(byName.get("Letter")?.placement).toEqual({
      kind: "leftOut",
      leftOut: { reason: "staysInFolder" },
    });
    expect(byName.has("Lease 9")).toBe(false);
    expect(byName.has("Lease 10")).toBe(false);
    expect(review.folders).toEqual([
      expect.objectContaining({ name: "NDAs", parentId: contracts.id, parentNewFolderId: null }),
    ]);
    expect(review.items.every((item) => item.origin === "folder")).toBe(true);
  });

  test("Stop ends the run with nothing written", async () => {
    const { core, sources } = await start({ holdSort: true });
    await add(core, sources, {
      "Lease 1.txt": "Lease.",
      "Lease 2.txt": "Lease.",
      "Lease 3.txt": "Lease.",
    });
    const running = core.organizeLibrary();
    await vi.waitFor(async () => {
      expect((await core.getOrganizeReview()).items).toHaveLength(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await core.stopOrganizeLibrary();
    expect(await running).toMatchObject({ status: "stopped" });
    expect((await core.getOrganizeReview()).items).toHaveLength(0);
  });

  test("a run estimated at more than $1 returns its estimate and sends nothing until accepted", async () => {
    const { core, dataDir, sources } = await start();
    await add(core, sources, {
      "Lease 1.txt": "Lease.",
      "Lease 2.txt": "Lease.",
      "Lease 3.txt": "Lease.",
    });
    const settings = (await core.getLibrary()).settings;
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      const { model, asked } = letterModel();
      let prepared = 0;
      const sizes: number[] = [];
      const organizer = createLibraryOrganizer({
        db,
        folders: () => [],
        settings: () => settings,
        language: () => "en",
        isExampleDocument: () => false,
        wallOf: () => null,
        embedding: { enabled: () => false, id: "none" },
        organizeService: () => null,
        prepare: async () => {
          prepared++;
          return { local: true, plan: model } as unknown as GroupClassifier;
        },
        estimate: (_, requests) => {
          sizes.push(requests.length);
          return {
            billing: "per-token",
            calls: requests.length,
            tokens: 1_500_000,
            cost: { currency: "USD", amount: 1.4 },
            spentTowardCap: null,
            setAsideTowardCap: null,
            cap: null,
          };
        },
        inDollars: (estimate) =>
          estimate.billing === "per-token" ? (estimate.cost?.amount ?? null) : null,
        tokensOf: approximateTokens,
        propose: () => 0,
        progress: () => {},
      });

      expect(await organizer.organize({})).toMatchObject({
        status: "estimate",
        estimate: { cost: { amount: 1.4 } },
      });
      expect(prepared).toBe(0);
      expect(asked.sorted).toHaveLength(0);
      expect(sizes).toEqual([1]);

      expect(await organizer.organize({ costAccepted: true })).toMatchObject({ status: "done" });
      expect(asked.sorted).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("Proposed subfolders in the Review", () => {
  test("show after their parent, confirm nested, and one Undo takes both back", async () => {
    const clock = manualClock("2026-11-07T09:00:00.000Z");
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { now: clock.now });
    const sources = await createSourceFolder();
    const [one, two] = await add(core, sources, {
      "Lease 1.txt": "Lease.",
      "Lease 2.txt": "Lease.",
    });
    if (!one || !two) throw new Error("Added.");
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      createOrganizeReviewStore(db, () => clock.now().toISOString()).propose(
        { origin: "library", runId: "run" },
        [one, two].map((doc, at) => ({
          documentId: doc.id,
          contentHash: null,
          placement: {
            kind: "newFolder" as const,
            name: at === 0 ? "Leases" : "Licences",
            description: "",
            parent: { name: "Contracts", description: "Agreements" },
          },
          tags: [],
        })),
      );
    } finally {
      db.close();
    }

    const review = await core.getOrganizeReview();
    expect(review.folders.map(({ name, parentId }) => ({ name, parentId }))).toEqual([
      { name: "Contracts", parentId: null },
      { name: "Leases", parentId: null },
      { name: "Licences", parentId: null },
    ]);
    const parent = review.folders[0];
    expect(review.folders.slice(1).map((folder) => folder.parentNewFolderId)).toEqual([
      parent?.id,
      parent?.id,
    ]);

    const confirmed = await core.confirmOrganizeReview(review.items.map((item) => item.id));
    const groups = (await core.getLibrary()).groups;
    const contracts = groups.find((group) => group.name === "Contracts");
    expect(contracts?.parentId).toBeNull();
    expect(
      groups
        .filter((group) => group.parentId === contracts?.id)
        .map((g) => g.name)
        .sort(),
    ).toEqual(["Leases", "Licences"]);
    expect(confirmed?.folderIds).toHaveLength(3);

    await core.undoOrganizeReviewConfirmation(confirmed?.id ?? "");
    expect((await core.getLibrary()).groups).toEqual([]);
    expect((await core.getOrganizeReview()).folders.map((folder) => folder.name)).toEqual([
      "Contracts",
      "Leases",
      "Licences",
    ]);
  });
});
