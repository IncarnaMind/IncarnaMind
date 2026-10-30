import { randomUUID } from "node:crypto";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
import type * as Y from "yjs";
import { type Document, MIND_CONTENT_FIELD } from "../../src/core/api";
import { isRecord } from "../../src/core/errors";
import { mindScopeOf, setMindScope } from "../../src/shared/mindScope";
import { sourceChoiceProblem } from "../../src/shared/sourceFacets";
import { listedSentences } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.unstubAllGlobals();
});

const LANGUAGES = [
  {
    language: "en",
    name: "Report",
    literal: "According to Report",
    fact: "Nora lives in Oslo.",
    text: "According to Report, Nora lives in Oslo.",
  },
  {
    language: "zh-CN",
    name: "报告",
    literal: "据报告",
    fact: "诺拉住在奥斯陆。",
    text: "据报告，诺拉住在奥斯陆。",
  },
] as const;
const MODES = [
  "unchanged",
  "renamed",
  "renamed-with-twins",
  "deleted",
  "out-of-scope",
  "walled",
  "unknown",
  "kept",
  "other",
] as const;
test.each(LANGUAGES.flatMap((row) => MODES.map((mode) => ({ ...row, mode }))))(
  "$language $mode selected Source has current standing on reopen",
  async (row) => {
    const plans = [
      { kind: "fact", text: row.literal, facet: { kind: "source" } },
      { kind: "fact", text: row.fact },
    ];
    const model = scriptedModel(
      (call) => {
        const searched = call.results.find((each) => each.tool === "search_documents");
        const targets = /^Judge these exact facet targets[^\n]*\n([^\n]+)/m.exec(call.prompt)?.[1];
        const requested: unknown = targets ? JSON.parse(targets) : [];
        const selected = Array.isArray(requested)
          ? requested.filter(isRecord).find((each) => each.kind === "source")?.document
          : undefined;
        if (!searched)
          return {
            text: `Parts: ${JSON.stringify(plans)}`,
            calls: [
              {
                tool: "search_documents",
                input: {
                  query: row.fact,
                  ...(typeof selected === "string" && { document: selected }),
                },
              },
            ],
          };
        if (!call.results.some((each) => each.tool === "cite")) {
          const passage = shownPassages(searched.text).find((each) => each.text.includes(row.fact));
          if (!passage) throw new Error("The real Source quote was not found.");
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: passage.id, quote: row.fact }] },
              },
            ],
          };
        }
        return {
          text: [
            "Verdict: supported",
            "Scope: none, same",
            "Topic: found",
            "Absence: no",
            "Roles: none, same",
            "Calculation: none",
            "Evidence: [1]",
            `${row.fact} [^1]`,
            `Facets: ${JSON.stringify({ items: [{ text: row.literal, kind: "source", occurrence: 1, sourceName: row.name, verdict: "supported", scope: "same", topic: "found", roles: "same", says: row.fact, evidence: [1] }] })}`,
          ].join("\n"),
        };
      },
      {
        generate(call) {
          if (!call.system.startsWith("You sort the sentences"))
            throw new Error("Unexpected auxiliary model request.");
          return {
            text: JSON.stringify({
              sentences: listedSentences(call.prompt).map(({ number, text }) => {
                if (text !== row.text) throw new Error("Unexpected sorter sentence.");
                return { number, parts: plans };
              }),
            }),
          };
        },
      },
    );
    const { core, mind, client } = await setUpWithDocuments(model, [], {
      now: manualClock("2026-10-29T12:00:00.000Z").now,
    });
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    await core.updateSettings({ user: { language: row.language } });
    const documents: Document[] = [];
    for (const period of row.mode === "renamed-with-twins"
      ? ["March 2024", "June 2025", "July 2025"]
      : ["March 2024", "June 2025"]) {
      const folder = await createTempDataFolder();
      const path = await writeSourceFile(
        folder,
        `${row.name}.md`,
        `# ${row.name}\n\n${period}\n\n${row.fact}\n`,
      );
      documents.push(...(await addAndProcess(core, [path])));
    }
    const selected = documents[1];
    if (!selected) throw new Error("The second same-title Source is missing.");
    const group =
      row.mode === "out-of-scope"
        ? await core.createLibraryGroup({ name: "Within", description: "" })
        : null;
    if (group) {
      for (const document of documents) await core.assignDocumentGroup(document.id, group.id);
      setMindScope(client.doc, { folderIds: [group.id], tagIds: [], documentIds: [] });
    }
    const blockId = randomUUID();
    writeMind(client, [
      { type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: row.text }] },
    ]);
    await client.settled();
    expect(
      await core.checkSentences({
        requestId: randomUUID(),
        mindId: mind.id,
        action: "check-against-documents",
        from: { blockId, offset: 0 },
        to: { blockId, offset: row.text.length },
      }),
    ).toMatchObject({ kind: "checked", checked: 1 });
    await client.settled();
    vi.resetModules();
    const dom = new DOMParser().parseFromString(
      "<html><head></head><body></body></html>",
      "text/html",
    );
    Object.defineProperty(dom, "styleSheets", { value: [] });
    Object.assign(dom.defaultView, { incarnamind: core });
    const globals: Record<string, unknown> = {
      window: dom.defaultView,
      document: dom,
      navigator: { languages: [row.language], platform: "Linux", userAgent: "", maxTouchPoints: 0 },
      requestAnimationFrame: (): number => 0,
      cancelAnimationFrame: (): void => undefined,
      getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    };
    for (const [key, value] of Object.entries(globals)) vi.stubGlobal(key, value);
    const { useAppStore } = await import("../../src/renderer/src/store");
    useAppStore.setState({
      documents,
      minds: [mind],
      folders: [],
      tags: [],
      settings: await core.getSettings(),
      library: await core.getLibrary(),
    });
    const { openMindCopy, flushMindUpdates } = await import("../../src/renderer/src/mindCopies");
    const local = await new Promise<Y.Doc>((resolve, reject) => {
      const close = openMindCopy(
        mind.id,
        ({ doc }) => (doc ? resolve(doc) : reject(new Error("The Note did not open."))),
        reject,
      );
      cleanup.push(close);
    });
    const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
    const { ClaimChecks, shownClaims, setClaimContext, claimSpans, keptSpans } = await import(
      "../../src/renderer/src/editor/claimChecks"
    );
    const { chooseSourceFacet } = await import("../../src/renderer/src/sourceFacetActions");
    const { sourceFacetChoices } = await import("../../src/renderer/src/sourceFacets");
    const { sourceChoiceAt } = await import("../../src/renderer/src/checks");
    const context = (editor: Editor, doc: Y.Doc, unknown = false) => {
      const state = useAppStore.getState();
      const library = unknown
        ? null
        : {
            documents: state.documents,
            folders: state.folders,
            tags: state.tags,
            groups: state.library?.groups,
            assignments: state.library?.assignments,
          };
      setClaimContext(editor.view, {
        versions: new Map(state.documents.map((document) => [document.id, document.contentHash])),
        folderId: mind.folderId,
        scope: mindScopeOf(doc),
        sourceChoicesValid: (check) => sourceChoiceProblem(check, library, mind.folderId) === null,
      });
    };
    const mount = (doc: Y.Doc) => {
      const editor = new Editor({
        element: dom.createElement("div", {}),
        editorProps: { handleScrollToSelection: () => true },
        extensions: [
          ...noteExtensions(),
          ClaimChecks,
          Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
        ],
      });
      editor.view.updateState(
        editor.state.reconfigure({ plugins: editor.extensionManager.plugins }),
      );
      context(editor, doc);
      cleanup.push(() => editor.destroy());
      return editor;
    };
    const current = (editor: Editor) => {
      const claim = shownClaims(editor.state)[0];
      if (!claim) throw new Error("The mounted Note lost its check.");
      return claim;
    };
    const editor = mount(local);
    const source = current(editor).check.parts?.find((part) => part.facet?.kind === "source");
    if (!source) throw new Error("The actual check has no Source row.");
    expect(source.verdict).toBe("unsupported");
    await chooseSourceFacet(editor, mind.id, local, current(editor), source, selected.id);
    await flushMindUpdates(mind.id);
    expect(current(editor).shown.state).toBe("supported");
    expect(
      current(editor).check.parts?.find((part) => part.facet?.kind === "source"),
    ).toMatchObject({
      verdict: "supported",
      facet: { selectedDocumentId: selected.id },
    });
    const calls = model.doStreamCalls.length + model.doGenerateCalls.length;
    const libraryOnly = row.mode === "out-of-scope" || row.mode === "walled";
    const stableVersions = new Map(
      documents.map((document) => [document.id, document.contentHash]),
    );
    const stableScope = mindScopeOf(local);
    const beforeLibrary = await core.getLibrary();
    if (libraryOnly) {
      setClaimContext(editor.view, {
        versions: stableVersions,
        folderId: mind.folderId,
        scope: stableScope,
        sourceChoicesValid: (check) =>
          sourceChoiceProblem(
            check,
            {
              documents,
              folders: [],
              tags: [],
              groups: beforeLibrary.groups,
              assignments: beforeLibrary.assignments,
            },
            mind.folderId,
          ) === null,
      });
      expect(current(editor).shown.state).toBe("supported");
    }
    if (row.mode === "kept") {
      const { keepAsView } = await import("../../src/renderer/src/unsupportedFixes");
      keepAsView(editor, current(editor));
      await flushMindUpdates(mind.id);
    }
    if (row.mode === "renamed" || row.mode === "renamed-with-twins" || row.mode === "kept") {
      const renamed = await core.renameDocument(selected.id, `${row.name} revised`);
      expect(renamed.contentHash).toBe(selected.contentHash);
    } else if (row.mode === "deleted") {
      await core.deleteDocument(selected.id);
    } else if (row.mode === "out-of-scope") {
      await core.assignDocumentGroup(selected.id, null);
    } else if (row.mode === "walled") {
      const wall = await core.createLibraryGroup({ name: "Within", description: "" });
      await core.assignDocumentGroup(selected.id, wall.id);
      await core.updateLibraryGroup(wall.id, {
        name: wall.name,
        description: "",
        keepInside: true,
      });
    } else if (row.mode === "other") {
      const other = documents.find((each) => each.id !== selected.id);
      if (!other) throw new Error("The unrelated Document is missing.");
      await core.renameDocument(other.id, `${row.name} revised`);
    }
    const live = await core.listDocuments();
    const library = await core.getLibrary();
    if (libraryOnly) {
      useAppStore.setState({ documents, library });
      setClaimContext(editor.view, {
        versions: stableVersions,
        folderId: mind.folderId,
        scope: stableScope,
        sourceChoicesValid: (check) =>
          sourceChoiceProblem(
            check,
            {
              documents,
              folders: [],
              tags: [],
              groups: library.groups,
              assignments: library.assignments,
            },
            mind.folderId,
          ) === null,
      });
      expect(model.doStreamCalls.length + model.doGenerateCalls.length).toBe(calls);
      expect(current(editor).shown).toEqual({ state: "needs-recheck", why: "source-choice" });
    }
    useAppStore.setState({ documents: live, library: row.mode === "unknown" ? null : library });
    const reopened = await connectToMind(core, mind.id);
    const reloaded = mount(reopened.doc);
    context(reloaded, reopened.doc, row.mode === "unknown");
    const check = claimSpans(reloaded.state.doc)[0]?.check;
    const part = check?.parts?.find((each) => each.facet?.kind === "source");
    if (!check || !part) throw new Error("The reopened Source row is missing.");
    const choices = sourceFacetChoices(
      check,
      part,
      {
        documents: live,
        folders: [],
        tags: [],
        groups: library.groups,
        assignments: library.assignments,
      },
      mind.folderId,
    );
    const standing = shownClaims(reloaded.state)[0]?.shown;
    const parent = standing?.state ?? (keptSpans(reloaded.state).length > 0 ? "kept" : null);
    const shown = {
      language: row.language,
      mode: row.mode,
      savedParent: check.state,
      savedSource: part.verdict,
      parent,
      ...(standing?.state === "needs-recheck" && { why: standing.why }),
      selectedStillOffered: choices?.choices.some((choice) => choice.document.id === selected.id),
    };
    console.info(JSON.stringify(shown));
    expect(model.doStreamCalls.length + model.doGenerateCalls.length).toBe(calls);
    expect(shown).toMatchObject({ savedParent: "supported", savedSource: "supported" });
    if (row.mode === "unchanged" || row.mode === "other") {
      expect(parent).toBe("supported");
    } else if (row.mode === "kept") {
      expect(parent).toBe("kept");
    } else {
      expect(shown).toMatchObject({ parent: "needs-recheck", why: "source-choice" });
    }
    const objectId = `${check.id}:${part.span.start}:${part.span.end}`;
    expect(sourceChoiceAt(reloaded, mind.id, objectId) !== null).toBe(
      row.mode === "unchanged" || row.mode === "renamed-with-twins",
    );
    if (row.mode === "renamed-with-twins") {
      context(editor, local);
      const before = current(editor);
      const target = before.check.parts?.find((each) => each.facet?.kind === "source");
      const other = live.find((document) => document.name === row.name);
      if (!target || !other) throw new Error("The remaining actual Source choice is missing.");
      expect(before.shown).toEqual({ state: "needs-recheck", why: "source-choice" });
      const { useUndo } = await import("../../src/renderer/src/undo");
      await chooseSourceFacet(editor, mind.id, local, before, target, other.id);
      await flushMindUpdates(mind.id);
      expect(current(editor).shown.state).toBe("supported");
      expect(
        current(editor).check.parts?.find((each) => each.facet?.kind === "source")?.facet,
      ).toMatchObject({ selectedDocumentId: other.id });
      expect(useUndo.getState().done).toHaveLength(1);
      const after = model.doStreamCalls.length + model.doGenerateCalls.length;
      await useUndo.getState().undo();
      await flushMindUpdates(mind.id);
      expect(current(editor).check).toEqual(before.check);
      expect(current(editor).shown).toEqual({ state: "needs-recheck", why: "source-choice" });
      expect(model.doStreamCalls.length + model.doGenerateCalls.length).toBe(after);
    }
  },
);
