/**
 * The fix-the-sentence set (./cases.ts, #3383) on a real model: each language's sentences in a
 * Note of a Folder that holds its Documents, the Note's check as the User runs it, and then each
 * sentence's card read as the app draws it, for the one-step fix it offers. One JSON line a
 * sentence goes to FIX_OUT.
 *
 * vitest run --config eval/fixSentence/vitest.config.ts, with INCARNAMIND_EVAL_CHAT_KIND,
 * INCARNAMIND_EVAL_CHAT_MODEL and INCARNAMIND_EVAL_CHAT_KEY (eval/README.md), FIX_OUT, FIX_ARM,
 * FIX_CAP_USD (the run stops past it). FIX_DRY=1 checks the set only, with no model.
 */
import { appendFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Editor, type JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { DOMParser } from "linkedom";
import { expect, test, vi } from "vitest";
import type { ChatModelFactory, Core } from "../../src/core";
import { CITATION_NODE } from "../../src/core/api";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { correctionsFor } from "../../src/renderer/src/correctionFixes";
import {
  ClaimChecks,
  type ShownClaim,
  setClaimContext,
  shownClaims,
} from "../../src/renderer/src/editor/claimChecks";
import { selectionForEdit } from "../../src/renderer/src/editor/editSelection";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { fixInstructionOf, offersFixSentence } from "../../src/renderer/src/fixSentence";
import {
  checkStateKey,
  offersFixes,
  offersNotFound,
  offersUseFigure,
  uncoveredOf,
} from "../../src/renderer/src/unsupportedFixes";
import { connectToMind, type MindClient } from "../../tests/helpers/mindClient";
import { readMind, resolveChanges, writeMind } from "../../tests/helpers/minds";
import { readConfig } from "../lib/config";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { FIX_DOCUMENTS, FIX_SENTENCES, type FixSentence } from "./cases";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
  requestEdit: vi.fn(),
  useEdits: { getState: () => ({ pending: {} }) },
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/i18n", () => ({
  languageNow: () => "en",
  translateNow: (key: string) => key,
}));

const dom = new DOMParser().parseFromString(
  "<!doctype html><html><head></head><body></body></html>",
  "text/html",
);
Object.assign(globalThis, {
  window: dom.defaultView,
  document: dom,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

const root = fileURLToPath(new URL("../..", import.meta.url));
const OUT = process.env.FIX_OUT ?? "";
const ARM = process.env.FIX_ARM ?? "unnamed";
const CAP_USD = Number(process.env.FIX_CAP_USD ?? "1");
const DRY = process.env.FIX_DRY === "1";
/** FIX_MODE=fix: each sentence Fix the sentence is offered on is fixed and checked again, and its Change to too. */
const FIXING = process.env.FIX_MODE === "fix";

/** The one-step fixes a sentence's card offers, as the card decides them. */
type Fix = "cut-unsupported" | "change-to" | "use-figure" | "document-wording";

/** Which of the issue's rows a card is in: by its one-step fix first, else by its verdict. */
type Row = "cut" | "correct" | "different" | "further" | "not-found" | "supported" | "other";

function fixesOf(editor: Editor, claim: ShownClaim): Fix[] {
  const fixes: Fix[] = [];
  if (offersFixes(editor, claim) && uncoveredOf(claim) !== null) fixes.push("cut-unsupported");
  if (correctionsFor(editor, claim).length > 0) fixes.push("change-to");
  if (offersUseFigure(editor, claim)) fixes.push("use-figure");
  const wording = (claim.check.parts ?? []).some(
    (part) =>
      part.unsupported?.kind === "forecast-certainty" &&
      (part.unsupported.quoted?.quote ?? part.evidence[0]?.quote),
  );
  if (wording) fixes.push("document-wording");
  return fixes;
}

function rowOf(editor: Editor, claim: ShownClaim, fixes: readonly Fix[]): Row {
  if (fixes.includes("cut-unsupported")) return "cut";
  if (fixes.length > 0) return "correct";
  const key = checkStateKey(editor, claim);
  const { state } = claim.shown;
  if (state === "contradicted" || (state === "unsupported" && claim.check.evidence !== null))
    return "different";
  if (key === "claim.state.overstated" || key === "claim.state.partly-supported") return "further";
  if (key === "claim.state.notFound" || offersNotFound(editor, claim)) return "not-found";
  if (state === "supported") return "supported";
  return "other";
}

/**
 * A Note's content in an editor as the app has it, its checks' shown states read by their plugin
 * against the Documents' versions and the Note's Folder, as the window gives them.
 */
function editorOf(
  content: JSONContent[],
  versions: ReadonlyMap<string, string>,
  folderId: string,
): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    content: { type: "doc", content },
    extensions: [...noteExtensions(), ClaimChecks],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  setClaimContext(editor.view, { footing: "not-yet-known", versions, folderId, scope: null });
  return editor;
}

async function spentUsd(core: Core): Promise<number> {
  const { spent } = await core.getCostSummary();
  return spent
    .filter((each) => each.currency === "USD")
    .reduce((sum, each) => sum + each.amount, 0);
}

/** Every request the core sends, counted, with the failed ones' messages. */
function counted() {
  const failed: string[] = [];
  let requests = 0;
  const failure = (error: unknown) =>
    error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error);
  const wrap =
    (inner: ChatModelFactory): ChatModelFactory =>
    (spec) =>
      wrapLanguageModel({
        model: inner(spec),
        middleware: {
          specificationVersion: "v4",
          wrapGenerate: async ({ doGenerate }) => {
            requests++;
            try {
              return await doGenerate();
            } catch (error) {
              failed.push(failure(error));
              throw error;
            }
          },
          wrapStream: async ({ doStream }) => {
            requests++;
            let result: Awaited<ReturnType<typeof doStream>>;
            try {
              result = await doStream();
            } catch (error) {
              failed.push(failure(error));
              throw error;
            }
            const stream = result.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  if (part.type === "error") failed.push(failure(part.error));
                  controller.enqueue(part);
                },
              }),
            );
            return { ...result, stream };
          },
        },
      }) as ReturnType<ChatModelFactory>;
  return { wrap, failed, requests: () => requests };
}

/** A Note's paragraph by its id, as the Mind holds it now. */
function paragraphOf(client: MindClient, id: string): { text: string; size: number } | null {
  let found: { text: string; size: number } | null = null;
  readMind(client).descendants((node) => {
    if (found) return false;
    if (node.isTextblock && node.attrs.id === id) {
      found = { text: node.textContent, size: node.content.size };
      return false;
    }
    return true;
  });
  return found;
}

/** The Note's verdict on one paragraph now, read as the card reads it. */
function verdictIn(
  client: MindClient,
  id: string,
  versions: ReadonlyMap<string, string>,
  folderId: string,
): { shown: string | null; key: string | null; evidence: string | null } {
  const editor = editorOf(
    (readMind(client).toJSON() as JSONContent).content ?? [],
    versions,
    folderId,
  );
  try {
    let place: { from: number; to: number } | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (place) return false;
      if (node.isTextblock && node.attrs.id === id) {
        place = { from: pos, to: pos + node.nodeSize };
        return false;
      }
      return true;
    });
    const at = place as { from: number; to: number } | null;
    const claim = at
      ? shownClaims(editor.state).find(
          (each) => at.from <= each.sentence.from && each.sentence.to <= at.to,
        )
      : undefined;
    return {
      shown: claim?.shown.state ?? null,
      key: claim ? checkStateKey(editor, claim) : null,
      evidence: claim?.reads.evidence?.quote ?? null,
    };
  } finally {
    editor.destroy();
  }
}

/** A Change to as the card writes it: each correction's first wording over its words, by code. */
function spliced(text: string, corrections: readonly { from: string; to: string }[]): string {
  let out = text;
  for (const { from, to } of corrections) {
    const at = out.indexOf(from);
    if (at >= 0 && at === out.lastIndexOf(from))
      out = `${out.slice(0, at)}${to}${out.slice(at + from.length)}`;
  }
  return out;
}

/** The set's own consistency: each cited sentence's Document holds its quote word for word. */
function setProblems(): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const each of FIX_SENTENCES) {
    if (ids.has(each.id)) problems.push(`${each.id}: its id is another's`);
    ids.add(each.id);
    const document = FIX_DOCUMENTS.find((candidate) => candidate.name === each.document);
    if (!document) problems.push(`${each.id}: no Document "${each.document}"`);
    else if (each.cites && !document.text.includes(each.cites))
      problems.push(`${each.id}: its Document doesn't write "${each.cites}"`);
  }
  return problems;
}

async function lineOf(core: Core, each: FixSentence, documentId: string): Promise<JSONContent> {
  const text: JSONContent = { type: "text", text: each.text };
  if (!each.cites) return { type: "paragraph", attrs: { id: each.id }, content: [text] };
  const [passage] = await core.searchPassages(each.cites, { documentIds: [documentId], limit: 1 });
  const cited = passage
    ? await core.citePassage({ passageId: passage.passageId, text: each.cites })
    : null;
  if (!cited) throw new Error(`${each.id}: its quote's Passage wasn't found.`);
  return {
    type: "paragraph",
    attrs: { id: each.id },
    content: [text, { type: CITATION_NODE, attrs: { ...cited } }],
  };
}

test(
  "the fix-the-sentence set",
  async () => {
    expect(setProblems()).toEqual([]);
    if (DRY) return;
    if (!OUT) throw new Error("No FIX_OUT.");
    const config = readConfig(root);
    if (!config.chat?.apiKey) throw new Error("No chat model: set INCARNAMIND_EVAL_CHAT_*.");
    const log = createLog(Date.now());
    const folder = await mkdtemp(join(tmpdir(), "fix-sentence-documents-"));
    const paths: { key: string; path: string }[] = [];
    for (const each of FIX_DOCUMENTS) {
      const path = join(folder, `${each.name}.md`);
      await writeFile(path, each.text);
      paths.push({ key: each.name, path });
    }
    const requests = counted();
    const library = await openLibrary({
      name: "fix-sentence",
      embedder: createFakeEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker: createWorkerCrossEncoder(config.rerankOnCpu),
      documents: paths,
      embeddings: false,
      keep: false,
      log,
      chatModels: requests.wrap,
    });
    const { core } = library;
    try {
      // Setting the variables is the consent to send the Note's sentences and Passages to the chat model.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(request.requestId, true);
      });
      await core.updateSettings({ user: { monthlyCap: { amount: 20, currency: "USD" } } });
      const saved = await core.saveChatProvider({
        kind: config.chat.kind,
        modelId: config.chat.modelId,
        apiKey: config.chat.apiKey ?? "",
      });
      if (saved.service) await core.allowDataFlow("chat", saved.service.id);
      const idOf = (name: string) => {
        const document = library.documents.get(name);
        if (!document) throw new Error(`${name} wasn't added.`);
        return document.id;
      };
      for (const language of ["en", "zh-CN"] as const) {
        if ((await spentUsd(core)) > CAP_USD) break;
        const group = await core.createLibraryGroup({ name: `Notes ${language}`, description: "" });
        await core.moveToFolder({
          documentIds: FIX_DOCUMENTS.filter((each) => each.language === language).map((each) =>
            idOf(each.name),
          ),
          folderId: group.id,
        });
        const sentences = FIX_SENTENCES.filter((each) => each.language === language);
        const mind = await core.createMind({ title: "Notes", folderId: group.id });
        const client = await connectToMind(core, mind.id);
        try {
          const lines = await Promise.all(
            sentences.map((each) => lineOf(core, each, idOf(each.document))),
          );
          writeMind(client, lines);
          await client.settled();
          const before = requests.requests();
          const failedBefore = requests.failed.length;
          const started = Date.now();
          const run = await core.checkMind({
            requestId: `${ARM}-${mind.id}`,
            mindId: mind.id,
            mode: "all",
          });
          const seconds = (Date.now() - started) / 1000;
          await client.settled();
          const content = (readMind(client).toJSON() as JSONContent).content ?? [];
          const versions = new Map(
            (await core.listDocuments()).map((document) => [document.id, document.contentHash]),
          );
          const editor = editorOf(content, versions, group.id);
          try {
            const claims = shownClaims(editor.state);
            for (const each of sentences) {
              const claim = claims.find((one) => one.sentence.text.trim() === each.text.trim());
              const fixes = claim ? fixesOf(editor, claim) : [];
              appendFileSync(
                OUT,
                `${JSON.stringify({
                  arm: ARM,
                  id: each.id,
                  language,
                  written: each.written,
                  cited: each.cites !== undefined,
                  run: run.kind,
                  shown: claim?.shown.state ?? null,
                  key: claim ? checkStateKey(editor, claim) : null,
                  evidence: claim?.check.evidence?.quote ?? null,
                  says: claim?.check.says ?? null,
                  uncovered: claim ? uncoveredOf(claim) : null,
                  fixes,
                  corrections: claim
                    ? correctionsFor(editor, claim).map(({ correction }) => ({
                        from: correction.from,
                        to: correction.choices.map((choice) => choice.wording),
                      }))
                    : [],
                  row: claim ? rowOf(editor, claim, fixes) : "unchecked",
                  noteSeconds: seconds,
                  noteRequests: requests.requests() - before,
                  failed: requests.failed.slice(failedBefore),
                })}\n`,
              );
            }
            if (FIXING) {
              const fixedRows: Record<string, unknown>[] = [];
              const changes: { each: FixSentence; text: string; cite: JSONContent | null }[] = [];
              for (const each of sentences) {
                const claim = claims.find((one) => one.sentence.text.trim() === each.text.trim());
                if (!claim) continue;
                const corrections = correctionsFor(editor, claim).flatMap(({ correction }) => {
                  const wording = correction.choices[0]?.wording;
                  return wording
                    ? [
                        {
                          from: correction.from,
                          to: wording,
                          evidence: correction.choices[0]?.evidence,
                        },
                      ]
                    : [];
                });
                if (corrections.length > 0) {
                  const cited = each.cites !== undefined;
                  const evidence = corrections[0]?.evidence;
                  changes.push({
                    each,
                    text: spliced(each.text, corrections),
                    cite: cited
                      ? (lines.find((line) => line.attrs?.id === each.id)?.content?.[1] ?? null)
                      : evidence
                        ? { type: CITATION_NODE, attrs: { ...evidence } }
                        : null,
                  });
                }
                if (!offersFixSentence(editor, claim)) continue;
                const instruction = fixInstructionOf(editor, claim);
                const selection = selectionForEdit(editor.state, {
                  from: claim.sentence.from,
                  to: claim.sentence.to,
                });
                if (!instruction || !selection) continue;
                const failedAt = requests.failed.length;
                const asked = Date.now();
                const result = await core.editWithAi({
                  requestId: `${ARM}-fix-${each.id}`,
                  mindId: mind.id,
                  from: selection.from,
                  to: selection.to,
                  text: selection.text,
                  action: "fix-sentence",
                  instruction,
                });
                await client.settled();
                await resolveChanges(client, "accept");
                const editSeconds = (Date.now() - asked) / 1000;
                const now = paragraphOf(client, each.id);
                const checked = Date.now();
                if (now && now.size > 0) {
                  await core.checkSentences({
                    requestId: `${ARM}-recheck-${each.id}`,
                    mindId: mind.id,
                    from: { blockId: each.id, offset: 0 },
                    to: { blockId: each.id, offset: now.size },
                    action: "check-against-documents",
                  });
                  await client.settled();
                }
                fixedRows.push({
                  arm: ARM,
                  id: each.id,
                  language,
                  written: each.written,
                  before: checkStateKey(editor, claim),
                  sentence: each.text,
                  instruction,
                  result: result.kind,
                  held: result.kind === "proposed" && result.held === true,
                  fixed: now?.text ?? null,
                  editSeconds,
                  checkSeconds: (Date.now() - checked) / 1000,
                  after: verdictIn(client, each.id, versions, group.id),
                  change: changes.find((change) => change.each.id === each.id)?.text ?? null,
                  failed: requests.failed.slice(failedAt),
                });
              }
              if (changes.length > 0) {
                const copy = await core.createMind({ title: "Change to", folderId: group.id });
                const copied = await connectToMind(core, copy.id);
                try {
                  writeMind(
                    copied,
                    changes.map(({ each, text, cite }) => ({
                      type: "paragraph",
                      attrs: { id: each.id },
                      content: [{ type: "text", text }, ...(cite ? [cite] : [])],
                    })),
                  );
                  await copied.settled();
                  await core.checkMind({
                    requestId: `${ARM}-change-${copy.id}`,
                    mindId: copy.id,
                    mode: "all",
                  });
                  await copied.settled();
                  for (const row of fixedRows) {
                    const id = String(row.id);
                    row.changed = changes.some((change) => change.each.id === id)
                      ? verdictIn(copied, id, versions, group.id)
                      : null;
                  }
                  for (const change of changes) {
                    if (fixedRows.some((row) => row.id === change.each.id)) continue;
                    fixedRows.push({
                      arm: ARM,
                      id: change.each.id,
                      language,
                      written: change.each.written,
                      before: null,
                      sentence: change.each.text,
                      change: change.text,
                      changed: verdictIn(copied, change.each.id, versions, group.id),
                    });
                  }
                } finally {
                  copied.goOffline();
                }
              }
              for (const row of fixedRows)
                appendFileSync(OUT.replace(/\.jsonl$/, "-fixes.jsonl"), `${JSON.stringify(row)}\n`);
            }
          } finally {
            editor.destroy();
          }
        } finally {
          client.goOffline();
        }
      }
      log(`done, US$${(await spentUsd(core)).toFixed(4)}`);
      appendFileSync(
        OUT.replace(/\.jsonl$/, "-run.jsonl"),
        `${JSON.stringify({ arm: ARM, model: config.chat.modelId, spent: await spentUsd(core), requests: requests.requests(), failed: requests.failed })}\n`,
      );
    } finally {
      await library.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
  60 * 60_000,
);
