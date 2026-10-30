import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
import type * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { listedSentences, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.unstubAllGlobals();
});

test.each([
  {
    language: "en",
    name: "Report",
    qualifier: "According to Report",
    claim: "According to Report, Nora lives in Oslo.",
    fact: "Nora lives in Oslo.",
    other: "Nora lives in Bergen.",
  },
  {
    language: "zh-CN",
    name: "报告",
    qualifier: "据报告",
    claim: "据报告，诺拉住在奥斯陆。",
    fact: "诺拉住在奥斯陆。",
    other: "诺拉住在卑尔根。",
  },
] as const)("$language Source choice survives whole checks and one Undo", async (row) => {
  const frames: ModelCall[] = [];
  const plans = [
    { kind: "fact", text: row.qualifier, facet: { kind: "source" } },
    { kind: "fact", text: row.fact },
  ];
  const model = scriptedModel(
    (call) => {
      frames.push(call);
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched)
        return {
          text: `Parts: ${JSON.stringify(plans)}`,
          calls: [
            {
              tool: "search_documents",
              input: { query: row.fact, ...(call.index > 0 && { document: row.name }) },
            },
          ],
        };
      const passages = shownPassages(searched.text);
      const passage =
        passages.find((each) => each.text.includes(row.fact)) ??
        passages.find((each) => each.text.includes(row.other));
      if (!passage) throw new Error("The actual named Source search returned no fixture quote.");
      const quote = passage.text.includes(row.fact) ? row.fact : row.other;
      if (!call.results.some((result) => result.tool === "cite"))
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage.id, quote }] } },
          ],
        };
      return {
        text: [
          `Verdict: ${quote === row.fact ? "supported" : "contradicted"}`,
          "Scope: none, same",
          "Topic: found",
          "Roles: none, same",
          "Calculation: none",
          "Evidence: [1]",
          `${quote} [^1]`,
          `Facets: ${JSON.stringify({ items: [{ text: row.qualifier, kind: "source", sourceName: row.name, occurrence: 1, verdict: "supported", scope: "same", topic: "found", roles: "same", says: quote, evidence: [1] }] })}`,
        ].join("\n"),
      };
    },
    {
      generate(call) {
        if (call.system.startsWith("You sort the sentences"))
          return {
            text: JSON.stringify({
              sentences: listedSentences(call.prompt).map(({ number, text }) => {
                if (text !== row.claim) throw new Error("Unexpected sentence in the sorter.");
                return { number, parts: plans };
              }),
            }),
          };
        if (call.system.startsWith("Compare a sentence")) return { text: "conflict" };
        throw new Error(`Unexpected auxiliary request: ${call.system.slice(0, 80)}`);
      },
    },
  );
  const clock = manualClock("2026-10-29T12:00:00.000Z");
  const { core, mind, client } = await setUpWithDocuments(model, [], { now: clock.now });
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: false });
  await core.updateSettings({ user: { language: row.language } });
  const sources = [];
  for (const quote of [row.fact, row.other]) {
    const folder = await createTempDataFolder();
    const path = await writeSourceFile(folder, `${row.name}.md`, `# ${row.name}\n\n${quote}\n`);
    const [source] = await addAndProcess(core, [path]);
    if (!source) throw new Error("The Source was not imported.");
    sources.push(source);
  }
  const blockId = crypto.randomUUID();
  writeMind(client, [
    { type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: row.claim }] },
  ]);
  await client.settled();
  const initialCheck = await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId, offset: 0 },
    to: { blockId, offset: row.claim.length },
  });
  await client.settled();
  expect(initialCheck).toMatchObject({ kind: "checked", checked: 1 });

  vi.resetModules();
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  Object.defineProperty(document.defaultView, "incarnamind", { value: core, configurable: true });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", document.defaultView);
  vi.stubGlobal("navigator", {
    languages: [row.language],
    platform: "Linux",
    userAgent: "",
    maxTouchPoints: 0,
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({
    fontStyle: "",
    fontWeight: "",
    fontSize: "",
    fontFamily: "",
  }));
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    documents: await core.listDocuments(),
    minds: await core.listMinds(),
    settings: await core.getSettings(),
    folders: await core.listFolders(),
    tags: await core.listTags(),
    library: await core.getLibrary(),
  });
  const { openMindCopy, flushMindUpdates } = await import("../../src/renderer/src/mindCopies");
  const copy = await new Promise<Y.Doc>((resolve, reject) => {
    const close = openMindCopy(
      mind.id,
      ({ doc }) => {
        if (doc) resolve(doc);
        else reject(new Error("The Note was not editable."));
      },
      reject,
    );
    cleanup.push(close);
  });
  const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
  const { ClaimChecks, shownClaims, claimSpans } = await import(
    "../../src/renderer/src/editor/claimChecks"
  );
  const { registerMindEditor } = await import("../../src/renderer/src/editor/openEditors");
  const { chooseSourceFacet } = await import("../../src/renderer/src/sourceFacetActions");
  const { checkAgain } = await import("../../src/renderer/src/checks");
  const { useUndo } = await import("../../src/renderer/src/undo");
  const editor = new Editor({
    element: document.createElement("div"),
    editorProps: { handleScrollToSelection: () => true },
    extensions: [
      ...noteExtensions(),
      ClaimChecks,
      Collaboration.configure({ document: copy, field: MIND_CONTENT_FIELD }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  const unregister = registerMindEditor(mind.id, editor);
  cleanup.push(() => {
    unregister();
    editor.destroy();
  });
  const current = () => {
    const claim = shownClaims(editor.state)[0];
    if (!claim) throw new Error("The mounted Note lost its sentence check.");
    return claim;
  };
  const original = structuredClone(current().check);
  expect(original.state).toBe("unsupported");
  const sourcePart = original.parts?.find((part) => part.facet?.kind === "source");
  const factPart = original.parts?.find((part) => !part.facet);
  if (!sourcePart || !factPart) throw new Error("The real check did not retain both fact rows.");
  expect(sourcePart.facet).toMatchObject({ kind: "source", candidates: expect.any(Array) });
  expect(sourcePart.verdict).toBe("unsupported");
  const priorDocument = factPart.evidence[0]?.documentId;
  expect(priorDocument).toBeTruthy();
  for (const part of original.parts ?? [])
    for (const citation of part.evidence) expect(citation.id).toMatch(/^[0-9a-f-]{36}$/i);
  const chosen = sources.find((source) => source.id !== priorDocument);
  if (!chosen) throw new Error("No other same-title Source was available.");
  useUndo.setState({ done: [], undone: [], line: null, running: null, making: 0 });
  const frameStart = frames.length;
  clock.advance(60_000);
  await chooseSourceFacet(editor, mind.id, copy, current(), sourcePart, chosen.id);
  await flushMindUpdates(mind.id);
  const assertChosen = () => {
    const parts = current().check.parts ?? [];
    expect(parts.find((part) => part.facet?.kind === "source")?.facet).toMatchObject({
      selectedDocumentId: chosen.id,
    });
    expect(parts.find((part) => part.facet?.kind === "source")?.verdict).toBe("supported");
    const fact = parts.find((part) => !part.facet);
    expect(fact?.verdict).toBe(factPart.verdict === "supported" ? "contradicted" : "supported");
    expect(fact?.evidence[0]).toMatchObject({
      documentId: chosen.id,
      check: "found",
      id: expect.any(String),
    });
  };
  assertChosen();
  const chosenReceipts = current().check.parts?.map((part) =>
    part.evidence.map((citation) => citation.id),
  );
  const reopened = await connectToMind(core, mind.id);
  expect(claimSpans(readMind(reopened))[0]?.check).toEqual(current().check);
  expect(current().check.request).not.toBe(original.request);
  expect(current().check.checkedAt).not.toBe(original.checkedAt);
  clock.advance(60_000);
  await checkAgain(editor, mind.id, copy, current());
  await flushMindUpdates(mind.id);
  assertChosen();
  expect(
    current().check.parts?.map((part) => part.evidence.map((citation) => citation.id)),
  ).toEqual(chosenReceipts);
  expect(frames.slice(frameStart).every((call) => sentenceOf(call) === row.claim)).toBe(true);
  const searches = frames
    .slice(frameStart)
    .flatMap((call) => call.results.filter((result) => result.tool === "search_documents"));
  expect(searches.length).toBeGreaterThan(0);
  expect(
    searches.every((result) =>
      shownPassages(result.text).some((passage) =>
        passage.text.includes(priorDocument === sources[0]?.id ? row.other : row.fact),
      ),
    ),
  ).toBe(true);
  const requestedSearches = frames
    .slice(frameStart)
    .flatMap((call) =>
      call.options.prompt.flatMap((message) =>
        message.role === "assistant"
          ? message.content.filter(
              (part) => part.type === "tool-call" && part.toolName === "search_documents",
            )
          : [],
      ),
    );
  expect(requestedSearches).not.toHaveLength(0);
  for (const request of requestedSearches)
    expect(request).toMatchObject({ input: { document: row.name, query: row.fact } });
  expect(useUndo.getState().done).toHaveLength(1);
  await useUndo.getState().undo();
  await flushMindUpdates(mind.id);
  expect(current().check).toEqual(original);
  const restored = await connectToMind(core, mind.id);
  expect(claimSpans(readMind(restored))[0]?.check).toEqual(original);
});
