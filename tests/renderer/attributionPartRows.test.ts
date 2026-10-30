import { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, ClaimCheckPart, ClaimFacet, Document } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { checkWithParts } from "../../src/shared/claimParts";
import { formatClaimFacetPeriod } from "../../src/shared/dates";
import { translate } from "../../src/shared/i18n";
import { sourceChoiceProblem } from "../../src/shared/sourceFacets";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModel } from "../helpers/models";

const PERIOD = { start: "2024-03-01", end: "2024-03-31", precision: "month" } as const;
const RECEIPT: CitationAttributes = {
  documentId: "facility",
  documentName: "Facility letter",
  passageId: "facility-clause",
  contentHash: "version-1",
  pageFrom: 2,
  pageTo: 2,
  location: { kind: "page", from: 2, to: 2 },
  quote: "As at March 2024, the term loan bears interest at 5% a year.",
  check: "found",
  checkReason: null,
};
const CASES = [
  {
    language: "en",
    source: "According to the annual report",
    speaker: "Nora said",
    time: "currently",
  },
  { language: "zh-CN", source: "根据年报", speaker: "诺拉说", time: "目前" },
] as const;

function part(text: string, words: string, facet: ClaimFacet): ClaimCheckPart {
  const start = text.indexOf(words);
  if (start < 0) throw new Error("The fixture's literal part is missing.");
  return {
    span: { start, end: start + words.length },
    kind: "fact",
    facet,
    verdict: "supported",
    evidence: [RECEIPT],
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    versions: [],
    excluded: [],
    citedCaseUnchecked: false,
    citedCaseFound: false,
  };
}

let root: Root | null = null;
let container: HTMLElement;
let editor: Editor | null = null;

beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) =>
        name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    navigator: { languages: ["en"], userAgent: "", platform: "" },
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function renderRows(
  language: Language,
  text: string,
  parts: ClaimCheckPart[],
  callbacks: {
    onChooseSource?(part: ClaimCheckPart, anchor: HTMLElement): void;
    onChangePeriod?(part: ClaimCheckPart): void;
    stale?: boolean;
    checking?: boolean;
  } = {},
) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: null });
  vi.stubGlobal("navigator", { languages: [language], userAgent: "", platform: "" });
  editor?.destroy();
  editor = new Editor({
    element: document.createElement("div"),
    extensions: noteExtensions(),
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  });
  const rowsPath = "../../src/renderer/src/editor/ClaimPartRows.tsx";
  const { ClaimPartRows }: { ClaimPartRows: ComponentType<Record<string, unknown>> } = await import(
    rowsPath
  );
  await act(() =>
    root?.render(
      createElement(ClaimPartRows, {
        editor,
        id: "check",
        text,
        parts,
        onCheck: () => undefined,
        onOpen: () => undefined,
        ...callbacks,
      }),
    ),
  );
}

describe.each(CASES)("attribution rows in $language", (sample) => {
  test("keeps exact source/speaker words and explains a supported time separately", async () => {
    const text = `${sample.source}, ${sample.speaker} the rate is ${sample.time} 5%.`;
    await renderRows(sample.language, text, [
      part(text, sample.source, { kind: "source" }),
      part(text, sample.speaker, { kind: "speaker" }),
      part(text, sample.time, { kind: "time", period: PERIOD }),
    ]);
    expect(
      [...container.querySelectorAll(".claim-part-words")].map((row) => row.textContent),
    ).toEqual([
      sample.source,
      sample.speaker,
      translate(sample.language, "claim.time.when", { time: sample.time }),
    ]);
    const time = container.querySelector('[data-facet="time"]');
    expect(time?.getAttribute("data-verdict")).toBe("supported");
    expect(time?.querySelector('[data-testid="claim-part-reason"]')?.textContent).toBe(
      translate(sample.language, "claim.time.supported", {
        period: formatClaimFacetPeriod(PERIOD, sample.language),
        document: RECEIPT.documentName ?? "",
      }),
    );
    expect(container.querySelector('[data-testid="claim-part-change-period"]')).toBeNull();
  });

  test("passes the original source part and button anchor to its chooser", async () => {
    const name = sample.language === "en" ? "annual report" : "年报";
    const { core, mind } = await setUpWithDocuments(
      scriptedModel(() => ({ text: "unused" })),
      [],
    );
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    const documents: Document[] = [];
    for (const year of [2024, 2025]) {
      const folder = await createTempDataFolder();
      const path = await writeSourceFile(folder, `${name}.md`, `# ${name}\n\n${year}: a report.\n`);
      documents.push(...(await addAndProcess(core, [path])));
    }
    const { useAppStore } = await import("../../src/renderer/src/store");
    const library = await core.getLibrary();
    useAppStore.setState({
      documents,
      minds: [mind],
      folders: [],
      tags: [],
      library,
      settings: null,
    });
    vi.stubGlobal("navigator", { languages: [sample.language], userAgent: "", platform: "" });
    const source: ClaimCheckPart = {
      ...part(sample.source, sample.source, {
        kind: "source",
        named: {
          start: sample.source.indexOf(name),
          end: sample.source.indexOf(name) + name.length,
        },
        candidates: documents.map((document) => ({ documentId: document.id })),
      }),
      verdict: "unsupported" as const,
      evidence: [],
      unsupported: {
        reason: "Choose which Document.",
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
        text: sample.source,
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
      [source],
    );
    const { ClaimChecks, setClaimContext } = await import(
      "../../src/renderer/src/editor/claimChecks"
    );
    editor?.destroy();
    editor = new Editor({
      element: document.createElement("div"),
      extensions: [...noteExtensions(), ClaimChecks],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { id: randomUUID() },
            content: [
              { type: "text", text: sample.source, marks: [{ type: "claimCheck", attrs: check }] },
            ],
          },
        ],
      },
    });
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
    setClaimContext(editor.view, {
      versions: new Map(documents.map((document) => [document.id, document.contentHash])),
      folderId: null,
      scope: null,
      sourceChoicesValid: (basis) =>
        sourceChoiceProblem(
          basis,
          {
            documents,
            folders: [],
            tags: [],
            groups: library.groups,
            assignments: library.assignments,
          },
          null,
        ) === null,
    });
    const choose = vi.fn();
    const rowsPath = "../../src/renderer/src/editor/ClaimPartRows.tsx";
    const { ClaimPartRows }: { ClaimPartRows: ComponentType<Record<string, unknown>> } =
      await import(rowsPath);
    const { MindIdContext } = await import("../../src/renderer/src/editor/mindContext");
    await act(() =>
      root?.render(
        createElement(
          MindIdContext.Provider,
          { value: mind.id },
          createElement(ClaimPartRows, {
            editor,
            id: check.id,
            text: sample.source,
            parts: [source],
            onCheck: () => undefined,
            onOpen: () => undefined,
            onChooseSource: choose,
          }),
        ),
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="claim-part-choose-source"]',
    );
    expect(button?.textContent).toBe(translate(sample.language, "claim.source.choose"));
    if (!button) throw new Error("The source chooser action is missing.");
    await act(() => button.click());
    expect(choose).toHaveBeenCalledExactlyOnceWith(source, button);
  });

  test("offers the canonical stated period to its correction callback", async () => {
    const time = {
      ...part(sample.time, sample.time, { kind: "time", period: PERIOD }),
      verdict: "unsupported" as const,
    };
    const change = vi.fn();
    await renderRows(sample.language, sample.time, [time], { onChangePeriod: change });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="claim-part-change-period"]',
    );
    expect(button?.textContent).toBe(
      translate(sample.language, "claim.time.changeTo", {
        period: formatClaimFacetPeriod(PERIOD, sample.language),
      }),
    );
    if (!button) throw new Error("The period correction action is missing.");
    await act(() => button.click());
    expect(change).toHaveBeenCalledExactlyOnceWith(time);
  });

  test("offers no fabricated period or unwired corrective action", async () => {
    const change = vi.fn();
    const noPeriod = {
      ...part(sample.time, sample.time, { kind: "time" }),
      verdict: "unsupported" as const,
    };
    await renderRows(sample.language, sample.time, [noPeriod], { onChangePeriod: change });
    expect(container.querySelector('[data-testid="claim-part-change-period"]')).toBeNull();
    const time = { ...noPeriod, facet: { kind: "time" as const, period: PERIOD } };
    await renderRows(sample.language, sample.time, [time]);
    expect(container.querySelector('[data-testid="claim-part-change-period"]')).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });

  test.each(["stale", "checking"] as const)("hides corrective actions while %s", async (state) => {
    const text = `${sample.source} ${sample.time}`;
    await renderRows(
      sample.language,
      text,
      [
        { ...part(text, sample.source, { kind: "source" }), verdict: "unsupported" },
        { ...part(text, sample.time, { kind: "time", period: PERIOD }), verdict: "unsupported" },
      ],
      { onChooseSource: vi.fn(), onChangePeriod: vi.fn(), [state]: true },
    );
    expect(container.querySelector('[data-testid="claim-part-choose-source"]')).toBeNull();
    expect(container.querySelector('[data-testid="claim-part-change-period"]')).toBeNull();
  });
});

import { randomUUID } from "node:crypto";
