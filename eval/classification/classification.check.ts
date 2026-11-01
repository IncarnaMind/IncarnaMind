/** Local models only. No app database, keys, embeddings, or model downloads. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { test } from "vitest";
import type { DocumentKind } from "../../src/core/api";
import { runJob } from "../../src/core/documents/processing";
import { decisionGroupClassifier } from "../../src/core/library/classifier";
import { documentPageImages } from "../../src/core/library/pageImages";
import type { DocumentPageImage } from "../../src/core/library/pdfImages";
import type { LibraryGroup } from "../../src/core/library/types";
import { type DocumentExcerpt, excerptFromPassages } from "../../src/core/tags/classify";

const root = process.cwd();
const output = join(root, "eval/results/classification");
const baseUrl = "http://127.0.0.1:11434";
const signal = new AbortController().signal;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const descriptions: Record<string, string> = {
  attention:
    "Attention mechanisms and the Transformer architecture, rather than language models in general.",
  "gradient-descent": "Gradient descent, stochastic gradient descent and optimisation algorithms.",
  "language-models": "Large language models, GPT systems, their capabilities and training.",
  sdgs: "United Nations programmes, sustainable development goals and international development.",
  esg: "Corporate environmental, social and governance reporting or socially responsible investing.",
  pharma: "Medicines, pharmaceutical companies and rules for pharmaceutical marketing.",
  tea: "Tea plants, beverages, production, processing and cultural history.",
  earthquakes: "Earthquakes, seismic events and seismology.",
  climate: "Climate change, greenhouse gases, carbon emissions and atmospheric warming.",
  mars: "The planet Mars, its physical characteristics and exploration.",
  photosynthesis:
    "Photosynthesis in plants, chlorophyll and conversion of light to chemical energy.",
  inflation: "Economic inflation, consumer prices and the consumer price index.",
};
const selected = [
  "attention-paper",
  "attention-zh",
  "gd-paper",
  "gd-zh",
  "lm-gpt3",
  "lm-gpt2",
  "lm-zh",
  "sdg-report",
  "sdg-zh",
  "esg-report",
  "esg-zh",
  "pharma-code",
  "tea-en",
  "tea-zh",
  "quake-en",
  "quake-zh",
  "climate-en",
  "climate-zh",
  "mars-en",
  "mars-zh",
  "photo-en",
  "photo-zh",
  "inflation-en",
  "inflation-zh",
];
interface Sample {
  id: string;
  path: string;
  subject: string | null;
  language: string;
}
interface Prepared extends Sample {
  contentHash: string;
  excerpt: DocumentExcerpt;
  images: DocumentPageImage[];
  preparationMs: number;
  renderMs: number;
}
interface Result {
  id: string;
  expected: string | null;
  actual: string | null;
  correct: boolean;
  language: string;
  kind: DocumentKind;
  ms: number;
  renderMs: number;
  imagePages: number[];
  error: string | null;
  loadedBytes: number;
  vramBytes: number;
}
interface VariantResult {
  fingerprint: string;
  model: string;
  variant: string;
  rows: Result[];
}
const variants: Record<string, { model: string; images: boolean; imageOnly?: boolean }> = {
  "tev-text": { model: "tev1:0.8b", images: false },
  "tev-4b-text": { model: "tev1:4b", images: false },
  "clef-text": { model: "clef-flash", images: false },
  "clef-images": { model: "clef-flash", images: true },
  "clef-images-only": { model: "clef-flash", images: true, imageOnly: true },
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
const save = (file: string, value: unknown) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const median = (rows: Result[]) => {
  const sorted = rows.map(({ ms }) => ms).sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0) : 0;
};

test("compare text and PDF images on fixed, labelled local fixtures", async () => {
  await mkdir(join(output, "prepared"), { recursive: true });
  const set = JSON.parse(await readFile(join(root, "eval/grouping/set.json"), "utf8")) as {
    subjects: Record<string, string>;
    documents: Record<string, { path: string; subject: string; language: string }>;
  };
  const samples: Sample[] = selected.map((id) => {
    const doc = set.documents[id];
    if (!doc) throw new Error(`Unknown sample ${id}`);
    return { id, ...doc };
  });
  samples.push(
    { id: "software-license", path: "LICENSE", subject: null, language: "en" },
    {
      id: "sales-orders",
      path: "tests/fixtures/formats/Orders.csv",
      subject: null,
      language: "en",
    },
  );
  const groups: LibraryGroup[] = Object.entries(descriptions).map(([subject, description]) => ({
    id: hash(subject).slice(0, 32),
    name: set.subjects[subject] ?? subject,
    description,
    parentId: null,
    countsOwnFiles: false,
    keepInside: false,
    createdAt: "",
    updatedAt: "",
  }));
  const subjects = new Map(
    Object.keys(descriptions).map((subject) => [hash(subject).slice(0, 32), subject]),
  );
  const code = await Promise.all(
    [
      "src/core/library/classifier.ts",
      "src/core/providers/jev.ts",
      "src/core/library/pdfImages.ts",
      "eval/classification/classification.check.ts",
    ].map((path) => readFile(join(root, path), "utf8")),
  );
  const sourceHashes = await Promise.all(
    samples.map(async (sample) => hash(await readFile(join(root, sample.path)))),
  );
  const fingerprint = hash(JSON.stringify({ code, samples, descriptions, sourceHashes }));
  const prepared: Prepared[] = [];
  for (const sample of samples) {
    const file = join(root, sample.path);
    const contentHash = hash(await readFile(file));
    const cacheFile = join(output, "prepared", `${sample.id}.json`);
    const cached = await readJson<{ fingerprint: string; sample: Prepared }>(cacheFile);
    if (cached?.fingerprint === fingerprint && cached.sample.contentHash === contentHash) {
      prepared.push(cached.sample);
      continue;
    }
    const start = performance.now();
    const ext = extname(file).toLowerCase();
    const kind: DocumentKind =
      ext === ".pdf" ? "pdf" : ext === ".md" ? "markdown" : ext === ".csv" ? "csv" : "text";
    const result = await runJob({ task: "process", documentId: sample.id, file, kind });
    if (result.outcome !== "ready" && result.outcome !== "no-text")
      throw new Error(`Cannot read ${sample.id}: ${JSON.stringify(result)}`);
    const renderStart = performance.now();
    const images = kind === "pdf" ? await documentPageImages(file, contentHash, signal) : [];
    const item: Prepared = {
      ...sample,
      contentHash,
      images,
      preparationMs: Math.round(performance.now() - start),
      renderMs: kind === "pdf" ? Math.round(performance.now() - renderStart) : 0,
      excerpt: {
        name: basename(file, ext),
        kind,
        pageCount: result.pageCount,
        text:
          result.outcome === "ready"
            ? excerptFromPassages(result.passages.map(({ text }) => text))
            : "",
      },
    };
    prepared.push(item);
    await save(cacheFile, { fingerprint, sample: item });
    console.log(
      `Prepared ${sample.id}: ${images.length} images, ${item.excerpt.text.length} text characters`,
    );
  }
  await save(join(output, "manifest.json"), {
    fingerprint,
    groups,
    samples: prepared.map(({ images, excerpt, ...sample }) => ({
      ...sample,
      textCharacters: excerpt.text.length,
      imagePages: images.map(({ page }) => page),
    })),
  });
  if (process.env.CLASSIFICATION_PREPARE_ONLY === "1") return;
  const names = (process.env.CLASSIFICATION_VARIANTS ?? Object.keys(variants).join(",")).split(",");
  for (const name of names) {
    const variant = variants[name];
    if (!variant) throw new Error(`Unknown variant ${name}`);
    const resultFile = join(output, `${name}.json`);
    const previous = await readJson<VariantResult>(resultFile);
    const report: VariantResult =
      previous?.fingerprint === fingerprint
        ? previous
        : {
            fingerprint,
            model: variant.model,
            variant: name,
            rows: [],
          };
    const classifier = decisionGroupClassifier({
      baseUrl,
      apiKey: "ollama",
      model: variant.model,
      local: true,
      usePageImages: variant.images,
    });
    let consecutiveErrors = 0;
    for (const sample of prepared) {
      if (variant.imageOnly && sample.excerpt.kind !== "pdf") continue;
      if (report.rows.some(({ id }) => id === sample.id)) continue;
      const start = performance.now();
      let actual: string | null = null;
      let error: string | null = null;
      try {
        const excerpt = variant.imageOnly
          ? { ...sample.excerpt, name: "Document.pdf", text: "" }
          : sample.excerpt;
        const chosen = await classifier.decide(
          groups,
          excerpt,
          signal,
          variant.images ? sample.images : [],
        );
        actual = chosen ? (subjects.get(chosen) ?? chosen) : null;
        consecutiveErrors = 0;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        consecutiveErrors++;
      }
      const ms = Math.round(performance.now() - start);
      const loaded = (await fetch(`${baseUrl}/api/ps`).then((response) => response.json())) as {
        models: { name: string; size: number; size_vram: number }[];
      };
      const model = loaded.models.find(
        ({ name: modelName }) =>
          modelName === variant.model || modelName === `${variant.model}:latest`,
      );
      const row: Result = {
        id: sample.id,
        expected: sample.subject,
        actual,
        correct: !error && actual === sample.subject,
        language: sample.language,
        kind: sample.excerpt.kind,
        ms,
        renderMs: variant.images ? sample.renderMs : 0,
        imagePages: variant.images ? sample.images.map(({ page }) => page) : [],
        error,
        loadedBytes: model?.size ?? 0,
        vramBytes: model?.size_vram ?? 0,
      };
      report.rows.push(row);
      await save(resultFile, report);
      console.log(
        `${name} ${sample.id}: ${error ?? actual ?? "Unsorted"} (${row.correct ? "correct" : "miss"}, ${ms} ms)`,
      );
      if (consecutiveErrors >= 3)
        throw new Error(`${name} failed three requests; partial results saved.`);
    }
    // Release the model before moving on; benchmark never changes the user's saved model settings.
    await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: variant.model, keep_alive: 0 }),
    });
  }
  const reports = (
    await Promise.all(
      Object.keys(variants).map((name) => readJson<VariantResult>(join(output, `${name}.json`))),
    )
  ).filter((value): value is VariantResult => value !== null && value.fingerprint === fingerprint);
  await save(
    join(output, "summary.json"),
    reports.map(({ model, variant, rows }) => ({
      model,
      variant,
      samples: rows.length,
      correct: rows.filter(({ correct }) => correct).length,
      errors: rows.filter(({ error }) => error).length,
      medianMs: median(rows),
      medianWarmMs: median(rows.slice(1)),
      maxLoadedBytes: Math.max(...rows.map(({ loadedBytes }) => loadedBytes)),
      maxVramBytes: Math.max(...rows.map(({ vramBytes }) => vramBytes)),
      english: {
        correct: rows.filter((row) => row.language === "en" && row.correct).length,
        total: rows.filter((row) => row.language === "en").length,
      },
      chinese: {
        correct: rows.filter((row) => row.language === "zh" && row.correct).length,
        total: rows.filter((row) => row.language === "zh").length,
      },
      pdf: {
        correct: rows.filter((row) => row.kind === "pdf" && row.correct).length,
        total: rows.filter((row) => row.kind === "pdf").length,
      },
    })),
  );
});
