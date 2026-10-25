/**
 * `npm run eval:organize`: Organize's accuracy on the labelled set (README.md).
 *
 * Per Document it runs the app's own code path: text extraction in the
 * processing code, the excerpt and page-image decision of
 * src/core/library/excerpt.ts, page rendering in the preview worker, and the
 * classifier each Library setting builds. No app database, embeddings or
 * model downloads; the User's data folder is never opened.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { nameFromPath } from "../../src/core/documents/files";
import { runJob } from "../../src/core/documents/processing";
import type { Language } from "../../src/core/language";
import {
  type OrganizeSource,
  organizeExcerpt,
  organizeNeedsPageImages,
  organizeReadsPages,
} from "../../src/core/library/excerpt";
import { documentPageImages } from "../../src/core/library/pageImages";
import type { DocumentPageImage } from "../../src/core/library/pdfImages";
import { readConfig } from "../lib/config";
import { markdownReport, type RouteResult, type RunInfo, summaryLines } from "./lib/report";
import {
  buildRoute,
  installedModels,
  ROUTES,
  type RouteName,
  unload,
  waitForOllama,
} from "./lib/routes";
import type { Prediction } from "./lib/scoring";
import { definitions, readSet, SET_DIRECTORY, type SetDocument, type Split } from "./lib/set";

const root = process.cwd();
const env = process.env;
const results = join(root, "eval", "results", "organize");
const save = (file: string, data: unknown) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const log = (line: string) => console.log(`[organize] ${line}`);
const NOT_ORGANIZED = "Not organized:";

/** The code whose change changes the results: a cached result is reused only without one. */
async function codeFingerprint(): Promise<string> {
  const files = [
    "src/core/tags/classify.ts",
    "src/core/tags/presets.ts",
    "src/core/providers/capabilities.ts",
    "src/core/providers/catalog/providers.ts",
    "src/core/providers/jev.ts",
    "src/core/providers/models.ts",
    "src/shared/i18n/en.ts",
    "src/shared/i18n/zh-CN.ts",
    "eval/organize/lib/routes.ts",
  ];
  for (const directory of ["src/core/library", "src/core/documents", "src/core/documents/formats"])
    for (const name of await readdir(join(root, directory)))
      if (name.endsWith(".ts")) files.push(`${directory}/${name}`);
  const contents = await Promise.all(files.sort().map((file) => readFile(join(root, file))));
  return hash(Buffer.concat(contents));
}

interface Prepared {
  doc: SetDocument;
  file: string;
  source: OrganizeSource;
  visual: boolean;
  /** Extraction found no text: only a route that reads page images can organize it. */
  noText: boolean;
}

async function prepare(doc: SetDocument): Promise<Prepared> {
  const file = join(root, SET_DIRECTORY, doc.file);
  const result = await runJob({ task: "process", documentId: doc.id, file, kind: doc.kind });
  if (result.outcome !== "ready" && result.outcome !== "no-text")
    throw new Error(`Extraction failed for ${doc.id}: ${JSON.stringify(result)}`);
  const source: OrganizeSource = {
    name: nameFromPath(file),
    kind: doc.kind,
    pageCount: result.pageCount,
    passages: result.outcome === "ready" ? result.passages.map((passage) => passage.text) : [],
    units: result.outcome === "ready" ? result.pages : [],
  };
  return {
    doc,
    file,
    source,
    visual: organizeNeedsPageImages(source),
    noText: result.outcome === "no-text",
  };
}

function choice<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === "") return fallback;
  if (!allowed.includes(value as T))
    throw new Error(`${name} must be one of ${allowed.join(", ")}, not "${value}".`);
  return value as T;
}

test("Organize on the labelled set", async () => {
  const set = await readSet(root);
  const config = readConfig(root);
  const language = choice<Language>(
    "INCARNAMIND_ORGANIZE_LANGUAGE",
    env.INCARNAMIND_ORGANIZE_LANGUAGE,
    ["en", "zh-CN"],
    "en",
  );
  const splitChoice = choice(
    "INCARNAMIND_ORGANIZE_SPLIT",
    env.INCARNAMIND_ORGANIZE_SPLIT,
    ["tune", "heldout", "all"],
    "all",
  );
  const splits: Split[] = splitChoice === "all" ? ["tune", "heldout"] : [splitChoice];
  const documentLanguage = choice(
    "INCARNAMIND_ORGANIZE_DOCUMENTS",
    env.INCARNAMIND_ORGANIZE_DOCUMENTS,
    ["all", "en", "zh"],
    "all",
  );
  const showHeldOut = env.INCARNAMIND_ORGANIZE_SHOW_HELDOUT === "1";
  const batch = Number(env.INCARNAMIND_ORGANIZE_BATCH ?? 10);
  if (!Number.isInteger(batch) || batch < 1)
    throw new Error("INCARNAMIND_ORGANIZE_BATCH must be a whole number of at least 1.");
  const ollama = (env.INCARNAMIND_ORGANIZE_OLLAMA ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const routeNames = (
    env.INCARNAMIND_ORGANIZE_ROUTES ?? `auto,tev-0.8b,clef-flash${config.chat ? ",chat" : ""}`
  )
    .split(",")
    .map((name) => choice<RouteName>("INCARNAMIND_ORGANIZE_ROUTES", name.trim(), ROUTES, "auto"));
  const thinking = choice(
    "INCARNAMIND_ORGANIZE_THINKING",
    env.INCARNAMIND_ORGANIZE_THINKING,
    ["off", "default"],
    "off",
  );
  const documents = set.documents.filter(
    (doc) =>
      splits.includes(doc.split) &&
      (documentLanguage === "all" || doc.language === documentLanguage),
  );
  const { folders, tags } = definitions(language);

  log(
    `Preparing ${documents.length} Documents (${splits.join(" + ")}${documentLanguage === "all" ? "" : `, ${documentLanguage} only`})…`,
  );
  const prepared: Prepared[] = [];
  for (const doc of documents) prepared.push(await prepare(doc));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const output = join(results, runId);
  await mkdir(output, { recursive: true });
  await save(
    join(output, "prepared.json"),
    prepared.map(({ doc, source, visual, noText }) => {
      const excerpt = organizeExcerpt(source);
      return {
        id: doc.id,
        name: excerpt.name,
        visual,
        noText,
        pageCount: source.pageCount,
        excerpt: excerpt.text,
      };
    }),
  );
  log(
    `Prepared: ${prepared.filter((p) => p.visual).length} need page images, ${prepared.filter((p) => p.noText).length} have no text.`,
  );
  if (env.INCARNAMIND_ORGANIZE_PREPARE_ONLY === "1") return;

  const models = await installedModels(ollama).catch(() => []);
  const version = await fetch(`${ollama}/api/version`, { signal: AbortSignal.timeout(3_000) })
    .then((response) => response.json() as Promise<{ version: string }>)
    .then((body) => body.version)
    .catch(() => null);
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  } catch {
    // Not a checkout: the report says so.
  }
  const info: RunInfo = {
    startedAt: new Date().toISOString(),
    commit,
    language,
    splits,
    machine: `${cpus()[0]?.model ?? "unknown CPU"}, ${Math.round(totalmem() / 2 ** 30)} GiB`,
    ollama: version,
    models: models.filter((m) => /^(tev1|clef-flash)/.test(m.name)),
    showHeldOut,
  };
  const code = await codeFingerprint();
  const routeResults: RouteResult[] = [];
  const signal = new AbortController().signal;
  await mkdir(join(results, "cache"), { recursive: true });

  for (const name of routeNames) {
    const route = buildRoute(name, { ollama, chat: config.chat, thinking });
    const fingerprint = hash(
      JSON.stringify({
        code,
        set: set.documents.map((doc) => [doc.id, doc.sha256]),
        folders,
        tags,
        route: route.label,
        thinking,
        models: route.models.map(
          (model) => models.find((m) => m.name.startsWith(model))?.digest ?? model,
        ),
      }),
    ).slice(0, 16);
    const cacheFile = join(results, "cache", `${name}-${fingerprint}.json`);
    const cached = new Map<string, Prediction>(
      await readFile(cacheFile, "utf8")
        .then((text) =>
          (JSON.parse(text) as Prediction[])
            // A failed request is asked again; a Document left for a route that can't read pages stays so.
            .filter((p) => p.error === null || p.error.startsWith(NOT_ORGANIZED))
            .map((p) => [p.id, p] as const),
        )
        .catch(() => []),
    );
    log(`${route.label}: ${cached.size} cached results reused.`);
    const predictions: Prediction[] = [];
    // Text first, then PDFs that need page images, as the Library orders a batch for Auto.
    const order = [...prepared].sort((a, b) => Number(a.visual) - Number(b.visual));
    let sinceUnload = 0;
    try {
      for (const item of order) {
        const done = cached.get(item.doc.id);
        if (done) {
          predictions.push(done);
          continue;
        }
        if (route.local) await waitForOllama(ollama, route.models, log);
        const prediction: Prediction = {
          id: item.doc.id,
          tags: [],
          error: null,
          ms: 0,
          renderMs: 0,
          model: null,
          images: false,
        };
        const { classifier } = route;
        try {
          const readsPages = organizeReadsPages(classifier.pageImages, item.source);
          // As the Library: a PDF without text waits unless the classifier reads its pages.
          if (item.noText && !readsPages)
            throw new Error(`${NOT_ORGANIZED} no text, and this route can't read page images.`);
          let images: DocumentPageImage[] = [];
          if (readsPages) {
            const rendering = performance.now();
            images = await documentPageImages(item.file, item.doc.sha256, signal);
            prediction.renderMs = Math.round(performance.now() - rendering);
          }
          // Only this Document's calls count: none before it, whatever stopped it.
          route.tokens?.();
          route.scores?.();
          const started = performance.now();
          const decision = await classifier.organize(
            folders,
            tags,
            organizeExcerpt(item.source),
            signal,
            images,
          );
          prediction.ms = Math.round(performance.now() - started);
          prediction.folder = decision.groupId;
          prediction.tags = decision.tags.map((tag) => ({
            key: tag.tagId,
            confidence: tag.confidence === null ? null : Math.round(tag.confidence * 1000) / 1000,
            needsReview: tag.needsReview,
          }));
          prediction.model = classifier.model?.id ?? null;
          prediction.images = images.length > 0 && (classifier.model?.images ?? true);
        } catch (error) {
          prediction.error = error instanceof Error ? error.message : String(error);
        }
        const tokens = route.tokens?.();
        if (tokens) prediction.tokens = tokens;
        const scores = route.scores?.();
        if (scores && Object.keys(scores).length) prediction.scores = scores;
        predictions.push(prediction);
        cached.set(prediction.id, prediction);
        await save(cacheFile, [...cached.values()]);
        // Ollama's decision endpoint can't cap the context, so Clef-Flash loads with its
        // Modelfile's 16K: stop the models after every batch, so none stays loaded long.
        if (route.local && ++sinceUnload >= batch) {
          await unload(ollama, route.models);
          sinceUnload = 0;
        }
        if (item.doc.split === "tune" || showHeldOut) {
          const folderOk = prediction.error === null && prediction.folder === item.doc.folder;
          log(
            `${name} ${item.doc.id}: ${prediction.error ?? `${prediction.folder ?? "Unsorted"}${folderOk ? "" : ` (labelled ${item.doc.folder ?? "Unsorted"})`}; ${prediction.tags.map((t) => `${t.key}${t.needsReview ? "?" : ""}`).join(", ") || "no Tags"} (labelled ${item.doc.tags.join(", ")})`}; ${prediction.ms} ms`,
          );
        } else log(`${name} ${item.doc.id}: done, ${prediction.ms} ms`);
      }
    } finally {
      if (route.local) await unload(ollama, route.models);
    }
    routeResults.push({
      route: name,
      label: route.label,
      predictions,
      ...(route.price && { price: route.price }),
    });
  }

  await save(join(output, "results.json"), { info, routes: routeResults });
  await writeFile(
    join(output, "report.md"),
    markdownReport(
      info,
      documents,
      routeResults,
      tags.map((tag) => tag.id),
    ),
  );
  for (const line of summaryLines(info, documents, routeResults)) log(line);
  log(`Report: ${join(output, "report.md")}`);
});
