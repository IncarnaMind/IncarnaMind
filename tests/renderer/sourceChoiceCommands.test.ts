import { randomUUID } from "node:crypto";
import { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { ClaimCheckAttributes, ClaimCheckPart } from "../../src/core/api";
import { checkWithParts, pendingPart } from "../../src/shared/claimParts";
import { translate } from "../../src/shared/i18n";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModel } from "../helpers/models";

afterEach(() => vi.unstubAllGlobals());

test.each([
  {
    language: "en",
    name: "Report",
    literal: "According to Report",
    text: "According to Report, Nora lives in Oslo.",
  },
  { language: "zh-CN", name: "报告", literal: "据报告", text: "据报告，诺拉住在奥斯陆。" },
] as const)("$language chooser uses its exact current Source row and tab", async (row) => {
  const model = scriptedModel(() => {
    throw new Error("Opening the chooser must not ask a model.");
  });
  const { core, mind } = await setUpWithDocuments(model, []);
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: false });
  await core.updateSettings({ user: { language: row.language } });
  const documents = [];
  for (const period of ["March 2024", "June 2025"]) {
    const folder = await createTempDataFolder();
    const path = await writeSourceFile(
      folder,
      `${row.name}.md`,
      `# ${row.name}\n\n${period}: Nora lives in Oslo.\n`,
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The actual same-name Source was not imported.");
    documents.push(document);
  }
  const first = documents[0];
  if (!first) throw new Error("The first Source is missing.");
  const passage = (await core.searchPassages("Nora Oslo")).find(
    (each) => each.documentId === first.id,
  );
  if (!passage) throw new Error("The actual first Source Passage is missing.");
  vi.resetModules();
  const dom = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.assign(dom.defaultView, { incarnamind: core });
  for (const [key, value] of Object.entries({
    window: dom.defaultView,
    document: dom,
    navigator: { languages: [row.language], platform: "Linux", userAgent: "", maxTouchPoints: 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  }))
    vi.stubGlobal(key, value);
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    documents,
    minds: [mind],
    folders: [],
    tags: [],
    library: await core.getLibrary(),
    settings: await core.getSettings(),
  });
  const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
  const { ClaimChecks } = await import("../../src/renderer/src/editor/claimChecks");
  const controller = await import("../../src/renderer/src/checks");
  const { noteHandle } = await import("../../src/renderer/src/commands/handles");
  const { checkCommands } = await import("../../src/renderer/src/commands/checks");
  const { menuIds } = await import("../../src/renderer/src/commands/menus");
  await import("../../src/renderer/src/commands/objectMenus");
  const part: ClaimCheckPart = {
    ...pendingPart({
      kind: "fact",
      span: { start: 0, end: row.literal.length },
      facet: {
        kind: "source",
        named: { start: row.literal.indexOf(row.name), end: row.literal.length },
        candidates: documents.map((document) => ({ documentId: document.id })),
      },
    }),
    verdict: "unsupported",
    unsupported: {
      reason: "More than one named Source.",
      found: true,
      covered: null,
      uncovered: null,
    },
  };
  const check = checkWithParts(
    {
      id: randomUUID(),
      request: randomUUID(),
      action: "check-against-documents",
      state: "unsupported",
      text: row.text,
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-10-29T12:00:00.000Z",
    },
    [
      part,
      {
        ...pendingPart({
          kind: "fact",
          span: {
            start: row.literal.length + (row.language === "en" ? 2 : 1),
            end: row.text.length,
          },
        }),
        verdict: "supported",
      },
    ],
  );
  const blockId = randomUUID();
  const paragraph = (attrs: ClaimCheckAttributes) => ({
    type: "paragraph",
    attrs: { id: blockId },
    content: [{ type: "text", text: row.text, marks: [{ type: "claimCheck", attrs }] }],
  });
  const editor = new Editor({
    element: dom.createElement("div", {}),
    extensions: [...noteExtensions(), ClaimChecks],
    content: { type: "doc", content: [paragraph(check)] },
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  const doc = new Y.Doc();
  const place = randomUUID();
  noteHandle.current = { editor, mindId: mind.id, doc, place };
  const command = checkCommands.find((each) => each.id === "check.chooseSource");
  if (!command) throw new Error("The Source chooser command is missing.");
  const context = { selection: [], focus: null, surface: "mind" } as const;
  const target = { id: check.id, span: part.span };
  const objectId = `${check.id}:${part.span.start}:${part.span.end}`;
  const mark = editor.schema.marks.claimCheck;
  if (!mark) throw new Error("The Note's check mark is missing.");
  const replace = (next: ClaimCheckAttributes) =>
    editor.view.dispatch(editor.state.tr.addMark(1, 1 + row.text.length, mark.create(next)));
  try {
    editor.commands.setTextSelection(2);
    expect(controller.sourceChoiceAt(editor, mind.id)?.part).toMatchObject(part);
    expect(command.when?.(context)).toBe(true);
    expect(command.label).toBe("claim.source.choose");
    expect(translate(row.language, "claim.source.choose")).toBe(
      row.language === "en" ? "Choose which one…" : "选择是哪一份…",
    );
    expect(menuIds("check")).toContain(command.id);
    controller.setCheckCardOpen(place, true);
    controller.setClaimFocus(place, "old-focus");
    await command.run(context);
    expect(controller.useChecks.getState()).toMatchObject({
      sourceChoice: { [place]: target },
      openClaim: { [place]: check.id },
    });
    expect(controller.useChecks.getState().sourceChoice[mind.id]).toBeUndefined();
    expect(controller.useChecks.getState().cardOpen[place]).toBeUndefined();
    expect(controller.useChecks.getState().focusClaim[place]).toBeUndefined();
    const otherPlace = randomUUID();
    controller.setSourceChoice(otherPlace, target);
    const successor = { ...target, span: { start: 1, end: part.span.end } };
    controller.setSourceChoice(place, successor);
    controller.clearSourceChoice(place, target);
    expect(controller.useChecks.getState().sourceChoice[place]).toEqual(successor);
    controller.clearSourceChoice(place, successor);
    expect(controller.useChecks.getState().sourceChoice[place]).toBeUndefined();
    expect(controller.useChecks.getState().sourceChoice[otherPlace]).toEqual(target);
    controller.clearSourceChoice(otherPlace, target);
    editor.commands.setTextSelection(row.text.length);
    expect(command.when?.(context)).toBe(false);
    expect(controller.sourceChoiceAt(editor, mind.id, objectId)?.part).toMatchObject(part);
    expect(controller.sourceChoiceAt(editor, mind.id, "another-row")).toBeNull();
    const here = vi.fn();
    await command.run({
      ...context,
      focus: { kind: "check", id: objectId },
      here: { "check.chooseSource": here },
    });
    expect(here).toHaveBeenCalledOnce();
    expect(controller.useChecks.getState().sourceChoice[place]).toBeUndefined();
    editor.commands.setTextSelection({ from: 2, to: row.text.length });
    expect(controller.sourceChoiceAt(editor, mind.id)).toBeNull();
    editor.commands.setTextSelection(2);
    controller.setCheckRunning(mind.id, { requestId: randomUUID(), action: "whole-mind" });
    expect(controller.sourceChoiceAt(editor, mind.id, objectId)).toBeNull();
    controller.setCheckRunning(mind.id, null);
    useAppStore.setState({
      documents: documents.map((document) => ({ ...document, name: `${document.name} revised` })),
    });
    expect(controller.sourceChoiceAt(editor, mind.id)).toBeNull();
    useAppStore.setState({ documents });
    replace({
      ...check,
      scope: { ...check.scope, chosen: { folderIds: [], tagIds: [], documentIds: [first.id] } },
    });
    expect(controller.sourceChoiceAt(editor, mind.id)).toBeNull();
    replace(
      checkWithParts(check, [
        {
          ...part,
          verdict: "supported",
          unsupported: null,
          decidingEvidence: 0,
          evidence: [
            {
              id: randomUUID(),
              passageId: passage.passageId,
              documentId: first.id,
              documentName: first.name,
              contentHash: first.contentHash,
              pageFrom: passage.pageFrom,
              pageTo: passage.pageTo,
              location: null,
              quote: passage.text,
              check: "found",
              checkReason: null,
            },
          ],
          facet: { ...part.facet, kind: "source", selectedDocumentId: first.id },
        },
        ...(check.parts?.slice(1) ?? []),
      ]),
    );
    expect(controller.sourceChoiceAt(editor, mind.id)?.part.facet).toMatchObject({
      selectedDocumentId: first.id,
    });
    replace(
      checkWithParts(
        check,
        (check.parts ?? []).map((each) =>
          pendingPart({
            kind: each.kind,
            span: each.span,
            ...(each.facet && { facet: each.facet }),
          }),
        ),
      ),
    );
    expect(controller.sourceChoiceAt(editor, mind.id)).toBeNull();
    replace(check);
    editor.commands.insertContentAt(2, "changed ");
    expect(controller.sourceChoiceAt(editor, mind.id, objectId)).toBeNull();
    expect(model.doStreamCalls).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(0);
  } finally {
    noteHandle.current = null;
    editor.destroy();
    doc.destroy();
  }
});
