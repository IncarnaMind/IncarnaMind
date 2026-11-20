/**
 * The deck set's run (#3455): each deck of `set.ts`, right and planted, goes through "Check
 * someone else's file" as the app runs it (verifyDocument, then its claims found and checked)
 * against the invented Documents, and every line's result is scored: the planted wrong figures,
 * the right lines, and each deck's tokens and seconds. Needs a chat model
 * (INCARNAMIND_EVAL_CHAT_*, eval/README.md); writes `decks.json` to INCARNAMIND_EVAL_DECKS_OUT,
 * or to eval/results/<start time>-decks/.
 */
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, MIND_SETTINGS_FIELD } from "../../src/core";
import { checkedSentences } from "../../src/core/answers/checks/sentences";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { readVerification } from "../../src/shared/verification";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { type RequestTokens, watchTokens } from "../lib/tokens";
import { DECKS, type Deck, deckFile } from "./set";

const root = fileURLToPath(new URL("../..", import.meta.url));
const DOCUMENTS = join(root, "eval", "decks", "documents");

/** List prices a million tokens, for the decks' cost beside their tokens; a model not listed has none. */
const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

const usdOf = (model: string, requests: readonly RequestTokens[]): number | null => {
  const price = PRICES[model];
  if (!price) return null;
  const sum = (field: "uncached" | "cacheRead" | "cacheWrite" | "output") =>
    requests.reduce((total, each) => total + each[field], 0);
  return (
    (sum("uncached") * price.input +
      sum("cacheWrite") * price.input * 1.25 +
      sum("cacheRead") * price.input * 0.1 +
      sum("output") * price.output) /
    1e6
  );
};

const textOf = (node: Y.XmlElement | Y.XmlText): string =>
  node instanceof Y.XmlText
    ? node.toString().replace(/<[^>]*>/g, "")
    : node
        .toArray()
        .map((child) =>
          child instanceof Y.XmlElement || child instanceof Y.XmlText ? textOf(child) : "",
        )
        .join(node.nodeName === "tableRow" ? " | " : "");

interface Line {
  slide: number | null;
  text: string;
  shown: string;
  word: string | null;
  planted: string | null;
}

interface DeckRun {
  id: string;
  layout: Deck["layout"];
  language: Deck["language"];
  planted: boolean;
  seconds: number;
  requests: number;
  tokens: { uncached: number; cacheRead: number; cacheWrite: number; output: number };
  usd: number | null;
  lines: Line[];
  /** The planted figures no line was checked for. */
  unchecked: string[];
}

const NEEDS_A_LOOK = new Set(["unsupported", "contradicted"]);

test("decks: stat cards, two-period columns and bullets, checked whole", async () => {
  const config = readConfig(root);
  const { chat } = config;
  if (!chat) {
    console.log("No chat model (INCARNAMIND_EVAL_CHAT_*): the deck set needs one. Stopped.");
    return;
  }
  const log = createLog(Date.now());
  const started = new Date();
  const out =
    process.env.INCARNAMIND_EVAL_DECKS_OUT ??
    join(root, "eval", "results", `${started.toISOString().replace(/[:.]/g, "-")}-decks`);
  const tokens = watchTokens();
  const names = await readdir(DOCUMENTS);
  const library = await openLibrary({
    name: "decks",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    chatModels: tokens.chatModels,
    documents: names.map((name) => ({ key: name, path: join(DOCUMENTS, name) })),
    embeddings: false,
    keep: config.keepData,
    log,
  });
  const files = await mkdtemp(join(tmpdir(), "im-decks-"));
  const runs: DeckRun[] = [];
  try {
    const { core } = library;
    // Setting the variables is the consent to send the decks' lines and Passages to the chat model.
    core.on("consent.requested", (request) => {
      core
        .respondToConsent(request.requestId, request.flow.id === "checks")
        .catch((error: unknown) => console.error(error));
    });
    await core.saveChatProvider({
      kind: chat.kind,
      modelId: chat.modelId,
      ...(chat.apiKey !== null && { apiKey: chat.apiKey }),
      ...(chat.baseUrl !== null && { baseUrl: chat.baseUrl }),
    });
    const cap = Number(process.env.INCARNAMIND_EVAL_SPEND_CAP);
    if (cap > 0)
      await core.updateSettings({ user: { monthlyCap: { amount: cap, currency: "USD" } } });
    const only = process.env.INCARNAMIND_EVAL_DECKS_ONLY?.split(",").filter(Boolean);
    for (const deck of DECKS.filter((each) => !only || only.includes(each.id))) {
      for (const planted of [false, true]) {
        const path = join(files, `${deck.name}${planted ? " (planted)" : ""}.pptx`);
        await writeFile(path, deckFile(deck, planted));
        tokens.take();
        const at = Date.now();
        const made = await core.verifyDocument({ path });
        if (!made.ok) throw new Error(`${deck.id}: not made, ${made.reason}`);
        const mindId = made.mind.id;
        const found = await core.findClaims({ requestId: crypto.randomUUID(), mindId });
        if (found.kind === "found") {
          await core.verifyClaims({ requestId: crypto.randomUUID(), mindId });
        }
        const seconds = Math.round((Date.now() - at) / 1000);
        const requests = tokens.take();
        const opened = await core.openMind(mindId);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, opened.state);
        const fragment = doc.getXmlFragment(MIND_CONTENT_FIELD);
        const pages = readVerification(doc.getMap(MIND_SETTINGS_FIELD))?.pages ?? {};
        const versions = new Map(
          (await core.listDocuments()).map((each) => [each.id, each.contentHash]),
        );
        const lines = checkedSentences(fragment).map(({ element, check, sentence }): Line => {
          const row = element.parent instanceof Y.XmlElement ? element.parent.parent : null;
          const text =
            row instanceof Y.XmlElement && row.nodeName === "tableRow" ? textOf(row) : sentence;
          const id = element.getAttribute("id");
          const shown = claimCheckShown(check, {
            footing: "not-yet-known",
            text: sentence,
            versions,
            folderId: null,
            scope: null,
          });
          return {
            slide: typeof id === "string" ? (pages[id] ?? null) : null,
            text,
            shown: shown.state,
            word: check.unsupported?.word ?? null,
            planted: planted
              ? (deck.plants.find((each) => text.includes(each.marker))?.marker ?? null)
              : null,
          };
        });
        // A checked deck is no Document for the next one's lines.
        await core.deleteDocuments([made.documentId]);
        const sum = (field: "uncached" | "cacheRead" | "cacheWrite" | "output") =>
          requests.reduce((total, each) => total + each[field], 0);
        const run: DeckRun = {
          id: deck.id,
          layout: deck.layout,
          language: deck.language,
          planted,
          seconds,
          requests: requests.length,
          tokens: {
            uncached: sum("uncached"),
            cacheRead: sum("cacheRead"),
            cacheWrite: sum("cacheWrite"),
            output: sum("output"),
          },
          usd: usdOf(chat.modelId, requests),
          lines,
          unchecked: planted
            ? deck.plants
                .map((each) => each.marker)
                .filter(
                  (marker) =>
                    !lines.some(
                      (line) =>
                        line.planted === marker &&
                        line.shown !== "checking" &&
                        line.shown !== "not-checked",
                    ),
                )
            : [],
        };
        runs.push(run);
        log(
          `${deck.id}${planted ? " planted" : ""}: ${lines.length} lines, ${run.requests} requests, ${seconds} s${run.usd === null ? "" : `, $${run.usd.toFixed(4)}`}`,
        );
      }
    }
  } finally {
    await library.close();
  }

  const plantedLines = runs.flatMap((run) => run.lines.filter((line) => line.planted !== null));
  const plants = runs
    .filter((run) => run.planted)
    .flatMap((run) => DECKS.find((deck) => deck.id === run.id)?.plants ?? []);
  const right = runs.flatMap((run) => run.lines.filter((line) => line.planted === null));
  const contradicted = new Set(
    runs.flatMap((run) =>
      run.lines
        .filter((line) => line.planted !== null && line.shown === "contradicted")
        .map((line) => `${run.id} ${line.planted}`),
    ),
  );
  const summary = {
    model: chat.modelId,
    startedAt: started.toISOString(),
    planted: plants.length,
    plantedContradicted: contradicted.size,
    plantedUnchecked: runs.flatMap((run) => run.unchecked.map((marker) => `${run.id} ${marker}`)),
    plantedLines: plantedLines.map(
      (line) => `${line.shown}${line.word ? ` (${line.word})` : ""}: ${line.text}`,
    ),
    rightLines: right.length,
    rightContradicted: right
      .filter((line) => line.shown === "contradicted")
      .map((line) => line.text),
    rightNeedsALook: right
      .filter(
        (line) =>
          NEEDS_A_LOOK.has(line.shown) && line.shown !== "contradicted" && line.word !== "own-view",
      )
      .map((line) => `${line.word ?? line.shown}: ${line.text}`),
    usd: runs.reduce((total, run) => total + (run.usd ?? 0), 0),
    seconds: runs.reduce((total, run) => total + run.seconds, 0),
  };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "decks.json"), JSON.stringify({ summary, runs }, null, 1));
  console.log(
    `Decks: ${summary.plantedContradicted} of ${summary.planted} planted figures Contradicted, ${summary.plantedUnchecked.length} unchecked; ${summary.rightContradicted.length} right lines Contradicted, ${summary.rightNeedsALook.length} of ${summary.rightLines} right lines need a look; $${summary.usd.toFixed(3)}, ${summary.seconds} s. ${join(out, "decks.json")}`,
  );
});
