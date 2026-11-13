import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, type ReactNode, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AnswerToolCall,
  ConversationAnswer,
  MarkedCitation,
  Meeting,
} from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { formatDateTime } from "../../src/shared/dates";

/*
 * An Answer in the assistant says when a cited Transcript's call started (#3005), in its
 * Citations' labels and the sources under its steps: an earlier call's, and this call's when
 * another cited Transcript has its name, so two calls named for the same day read apart. An Answer
 * citing only the call recording now says no start.
 */

const NAME = "Transcript · Meeting, 12 November";
const EARLIER = "2026-11-12T09:00:00.000Z";
const THIS = "2026-11-12T12:00:00.000Z";
const STARTED_WORD: Record<Language, string> = { en: "started", "zh-CN": "开始于" };
const STARTED: Record<Language, (at: string) => string> = {
  en: (at) => `started ${formatDateTime(at, "en")}`,
  "zh-CN": (at) => `开始于 ${formatDateTime(at, "zh-CN")}`,
};

let root: Root | null = null;
let container: HTMLElement;
let Shown: ComponentType<{ answer: ConversationAnswer }>;
let setLanguage: (language: Language) => void;

beforeEach(async () => {
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
        name === "on"
          ? each.on
          : () => Promise.resolve(String(name).startsWith("list") ? [] : undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
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
    CSS: { escape: (text: string) => text },
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);

  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    status: { kind: "ready" },
    documents: ["earlier", "this"].map((id) => ({
      id,
      name: NAME,
      kind: "transcript",
      contentHash: "version",
    })),
    library: null,
    minds: [],
    keptCitationTexts: [],
  } as never);
  setLanguage = (language) => useAppStore.setState({ settings: { language, user: {} } as never });
  const { useMeetings } = await import("../../src/renderer/src/meetings");
  useMeetings.setState({
    meetings: [
      call("earlier", "stopped", EARLIER),
      call("this", "recording", THIS),
      call("memo", "stopped", "2026-11-12T08:00:00.000Z", "memo"),
    ],
  });
  const { citedBy } = await import("../../src/renderer/src/answerSteps");
  const { CallStartsContext, useCallStarts } = await import("../../src/renderer/src/callStarts");
  const { AssistantFoldedContext, JudgedAnswerContext } = await import(
    "../../src/renderer/src/editor/mindContext"
  );
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const stepsPath = "../../src/renderer/src/components/assistant/AnswerSteps";
  const viewPath = "../../src/renderer/src/editor/CitationView";
  const { AnswerSteps }: { AnswerSteps: ComponentType<Record<string, unknown>> } = await import(
    stepsPath
  );
  const { CitationView }: { CitationView: ComponentType<Record<string, unknown>> } = await import(
    viewPath
  );
  // What an Answer in the assistant draws of its sources: its steps, and its Citations as its text
  // draws them, in the starts `AssistantAnswer` gives them.
  Shown = ({ answer }) => {
    const { citations, toolCalls } = answer;
    const cited = useMemo(() => citedBy({ citations, toolCalls }), [citations, toolCalls]);
    const starts = useCallStarts(cited);
    const chips: ReactNode[] = citations.map((citation) =>
      createElement(CitationView, {
        key: citation.marker,
        node: { attrs: citation },
        editor: { isEditable: false },
        getPos: () => 0,
        deleteNode: () => undefined,
        updateAttributes: () => undefined,
        decorations: [],
      }),
    );
    return createElement(
      CallStartsContext.Provider,
      { value: starts },
      createElement(AnswerSteps, {
        answer,
        question: undefined,
        streaming: false,
        waitingForApproval: false,
        wait: null,
        onRegenerate: () => undefined,
      }),
      createElement(
        AssistantFoldedContext.Provider,
        { value: false },
        createElement(JudgedAnswerContext.Provider, { value: answer }, ...chips),
      ),
    );
  };
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

function call(
  id: string,
  status: Meeting["status"],
  startedAt: string,
  kind: Meeting["kind"] = "meeting",
): Meeting {
  return { id, kind, status, startedAt, transcript: { documentId: id } } as unknown as Meeting;
}

const cited = (marker: number, documentId: string): MarkedCitation => ({
  marker,
  passageId: `${documentId}-passage`,
  documentId,
  documentName: NAME,
  contentHash: "version",
  pageFrom: null,
  pageTo: null,
  location: { kind: "time", from: 61_000, to: 64_000 },
  quote: "Our data has to stay in Europe.",
  check: "found",
  checkReason: null,
});

function answerCiting(...citations: MarkedCitation[]): ConversationAnswer {
  const search: AnswerToolCall = {
    id: "search",
    tool: "search_documents",
    source: "documents",
    input: { query: "data" },
    status: "done",
    resultCount: citations.length,
    passages: citations.map((citation) => citation.passageId),
  };
  return {
    kind: "answer",
    id: "answer",
    conversationId: "conversation",
    questionId: "question",
    text: `They said so ${citations.map((citation) => `[^${citation.marker}]`).join(" ")}.`,
    citations,
    figures: [],
    analyses: [],
    model: { providerId: "scripted", modelId: "scripted-model" },
    status: "done",
    errorKind: null,
    errorMessage: null,
    errorSignInRoute: null,
    citationSupport: "tools",
    toolCalls: [search],
    textOrigin: null,
    read: null,
    steps: null,
    createdAt: "2026-11-12T12:30:00.000Z",
    updatedAt: "2026-11-12T12:30:00.000Z",
  };
}

const all = (testId: string) =>
  Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));

/** What the User reads of each source: its chip's label, its card's source line, its row under the steps. */
async function sourcesShown(answer: ConversationAnswer) {
  await act(() => root?.render(createElement(Shown, { answer })));
  const toggle = all("answer-steps")[0];
  if (!toggle) throw new Error("The Answer has no steps to open.");
  await act(() => {
    toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  return {
    labels: all("citation-chip").map((chip) => chip.getAttribute("aria-label") ?? ""),
    rows: all("answer-step-source").map((row) => ({
      text: row.textContent ?? "",
      title: row.getAttribute("title") ?? "",
    })),
  };
}

for (const language of ["en", "zh-CN"] as const) {
  describe(`${language}: an Answer in the assistant`, () => {
    const started = STARTED[language];

    test("citing two Transcripts with one name shows each with its call's start", async () => {
      setLanguage(language);
      const { labels, rows } = await sourcesShown(
        answerCiting(cited(1, "earlier"), cited(2, "this")),
      );

      expect(labels).toHaveLength(2);
      expect(labels[0]).toContain(NAME);
      expect(labels[0]).toContain(started(EARLIER));
      expect(labels[1]).toContain(started(THIS));
      expect(labels[0]).not.toBe(labels[1]);
      expect(rows.map((row) => row.text)).toEqual([
        expect.stringContaining(started(EARLIER)),
        expect.stringContaining(started(THIS)),
      ]);
      for (const row of rows) expect(row.text.startsWith(NAME)).toBe(true);
      expect(rows[0]?.title).toContain(started(EARLIER));
      expect(rows[1]?.title).toContain(started(THIS));
    });

    test("citing only the call recording now shows no start", async () => {
      setLanguage(language);
      const { labels, rows } = await sourcesShown(answerCiting(cited(1, "this")));

      expect(labels).toHaveLength(1);
      expect(labels[0]).toContain(NAME);
      expect(rows).toHaveLength(1);
      for (const shown of [labels[0], rows[0]?.text, rows[0]?.title]) {
        expect(shown).not.toContain(STARTED_WORD[language]);
      }
    });

    test("citing an earlier call's Transcript alone shows its start", async () => {
      setLanguage(language);
      const { labels, rows } = await sourcesShown(answerCiting(cited(1, "earlier")));

      expect(labels[0]).toContain(started(EARLIER));
      expect(rows[0]?.text).toContain(started(EARLIER));
    });
  });
}

describe("Where a cited Transcript is", () => {
  // protects=#3005: a Meeting's Transcript that shares its name shows when its call started, not the name of IncarnaMind's own folder it is kept in ("Transcripts (2)", English in every language); fails_when=the card's place is the on-disk folder; no_claim=Documents of the User's, which keep their folders.
  test.each(["en", "zh-CN"] as const)(
    "%s: two calls' Transcripts kept in one folder each show their call's start, and the User's own twins keep their folders",
    async (language) => {
      setLanguage(language);
      const { useAppStore } = await import("../../src/renderer/src/store");
      const { useDocumentPlace } = await import("../../src/renderer/src/documentPlaces");
      useAppStore.setState({
        documents: [
          {
            id: "earlier",
            name: NAME,
            kind: "transcript",
            meetingMindId: "note-earlier",
            path: "/data/Transcripts/a.vtt",
          },
          {
            id: "this",
            name: NAME,
            kind: "transcript",
            meetingMindId: "note-this",
            path: "/data/Transcripts/b.vtt",
          },
          {
            id: "report-2025",
            name: "Report",
            kind: "text",
            meetingMindId: null,
            path: "/Reports/2025/Report.md",
          },
          {
            id: "report-2026",
            name: "Report",
            kind: "text",
            meetingMindId: null,
            path: "/Reports/2026/Report.md",
          },
        ],
        linkedFolders: [],
      } as never);
      const places: Record<string, string | null> = {};
      function Probe({ id }: { id: string }) {
        places[id] = useDocumentPlace(id);
        return null;
      }
      await act(async () =>
        root?.render(
          ["earlier", "this", "report-2025", "report-2026"].map((id) =>
            createElement(Probe, { key: id, id }),
          ),
        ),
      );
      expect(places).toEqual({
        earlier: STARTED[language](EARLIER),
        this: STARTED[language](THIS),
        "report-2025": "2025",
        "report-2026": "2026",
      });
    },
  );
});
