import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConversationAnswer,
  ConversationQuestion,
  MarkedCitation,
  Meeting,
} from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { translate } from "../../src/shared/i18n";
import { helpLabel } from "../../src/shared/meetingHelp";

/*
 * A help button's reply in the assistant keeps a Citation of another call's Transcript, which its
 * check leaves out on purpose (#3005): the Citation's card says Not checked, and why. Any other
 * Citation left unchecked keeps the general line.
 */

let root: Root | null = null;
let Shown: ComponentType<{ question: ConversationQuestion; answer: ConversationAnswer }>;
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
  Object.assign(window, {
    incarnamind: bridge,
    incarnamindFiles: bridge,
    // Reduce motion: the card shows at once, and reports nothing.
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    reportError: () => undefined,
  });
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
  // The native popover the card opens in, which linkedom doesn't have.
  const prototype = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  prototype.showPopover = () => undefined;
  prototype.hidePopover = () => undefined;
  const element = window.Element.prototype as unknown as { matches(selector: string): boolean };
  const matches = element.matches;
  element.matches = function (this: Element, selector: string) {
    return selector === ":popover-open" ? false : matches.call(this, selector);
  };
  const container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);

  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    status: { kind: "ready" },
    documents: ["earlier", "this"].map((id) => ({
      id,
      name: `Transcript · ${id}`,
      kind: "transcript",
      contentHash: "version",
      meetingMindId: `note-${id}`,
      path: `/data/Transcripts/${id}.vtt`,
    })),
    linkedFolders: [],
    library: null,
    minds: [],
    keptCitationTexts: [],
  } as never);
  setLanguage = (language) => useAppStore.setState({ settings: { language, user: {} } as never });
  const { useMeetings } = await import("../../src/renderer/src/meetings");
  useMeetings.setState({
    meetings: [call("earlier", "stopped"), call("this", "recording")],
  });
  const { OtherCallsContext, useOtherCalls } = await import("../../src/renderer/src/callStarts");
  const { AssistantFoldedContext, JudgedAnswerContext } = await import(
    "../../src/renderer/src/editor/mindContext"
  );
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const viewPath = "../../src/renderer/src/editor/CitationView";
  const { CitationView }: { CitationView: ComponentType<Record<string, unknown>> } = await import(
    viewPath
  );
  // An Answer's Citations as the assistant draws them, in the other calls `AssistantAnswer` gives.
  Shown = ({ question, answer }) =>
    createElement(
      OtherCallsContext.Provider,
      { value: useOtherCalls(question, answer) },
      createElement(
        AssistantFoldedContext.Provider,
        { value: false },
        createElement(
          JudgedAnswerContext.Provider,
          { value: answer },
          ...answer.citations.map((citation) =>
            createElement(CitationView, {
              key: citation.marker,
              node: { attrs: citation },
              editor: { isEditable: false },
              getPos: () => 0,
              deleteNode: () => undefined,
              updateAttributes: () => undefined,
              decorations: [],
            }),
          ),
        ),
      ),
    );
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function call(id: string, status: Meeting["status"]): Meeting {
  return {
    id,
    mindId: `note-${id}`,
    kind: "meeting",
    status,
    startedAt: "2026-11-12T09:00:00.000Z",
    transcript: { documentId: id },
  } as unknown as Meeting;
}

const notChecked = (documentId: string): MarkedCitation => ({
  marker: 1,
  passageId: `${documentId}-passage`,
  documentId,
  documentName: `Transcript · ${documentId}`,
  contentHash: "version",
  pageFrom: null,
  pageTo: null,
  location: { kind: "time", from: 61_000, to: 64_000 },
  quote: "Our data has to stay in Europe.",
  check: "not-checked",
  checkReason: null,
});

const questionOf = (text: string, deleted = false): ConversationQuestion =>
  ({
    kind: "question",
    id: "question",
    conversationId: "conversation",
    text,
    askedFrom: { mindId: "note-this", name: "Meeting", deleted },
  }) as unknown as ConversationQuestion;

const answerCiting = (citation: MarkedCitation, withTheCall: boolean): ConversationAnswer =>
  ({
    kind: "answer",
    id: "answer",
    conversationId: "conversation",
    questionId: "question",
    text: "★ Your data stays in Europe [^1]",
    citations: [citation],
    figures: [],
    analyses: [],
    model: { providerId: "scripted", modelId: "scripted-model" },
    status: "done",
    steps: { sent: { documents: [], ...(withTheCall && { transcript: true }) } },
  }) as unknown as ConversationAnswer;

/** The Citation's card as the User opens it: its badge and its reason line. */
async function cardOf(question: ConversationQuestion, answer: ConversationAnswer) {
  await act(() => root?.render(createElement(Shown, { question, answer })));
  const chip = document.querySelector('[data-testid="citation-chip"]');
  if (!chip) throw new Error("No Citation is drawn.");
  await act(() => {
    chip.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  const element = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
  const text = (testId: string) => element(testId)?.textContent ?? "";
  const primary = document.querySelector(
    '[data-testid="citation-card"] .citation-card-action--primary',
  );
  return {
    badge: text("citation-badge"),
    reason: text("citation-reason"),
    checkAgain: element("citation-check-again") !== null,
    open: text("citation-open"),
    primary: primary?.getAttribute("data-testid") ?? null,
  };
}

for (const language of ["en", "zh-CN"] as const) {
  describe(`${language}: a Citation left unchecked in an Answer in the assistant`, () => {
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    const press = translate(language, helpLabel("say"));
    const OTHER_CALL = {
      en: "The quote is from another call. A call help reply is checked against its own call and your Documents.",
      "zh-CN": "引文出自另一场会议。通话助手的回复只对照这场会议和你的文档核对。",
    }[language];

    // protects=#3005: a press's reply's Citation of another call says it was left out on purpose, and offers no Check again, which can never check it; fails_when=its card gives the general "couldn't be checked" line, or offers Check again; no_claim=the panel's chip.
    test("on a press's reply, of another call's Transcript: Not checked, as the quote is from another call, with no Check again", async () => {
      setLanguage(language);
      const card = await cardOf(questionOf(press), answerCiting(notChecked("earlier"), true));

      expect(card.badge).toContain(t("citation.badge.notChecked"));
      expect(card.reason).toBe(OTHER_CALL);
      expect(card.checkAgain).toBe(false);
      expect(card.open).toBe(t("citation.open.time"));
      expect(card.primary).toBe("citation-open");
    });

    test("on a press's reply whose Note is gone, of any call's Transcript: the same", async () => {
      setLanguage(language);
      const card = await cardOf(questionOf(press, true), answerCiting(notChecked("this"), true));

      expect(card.reason).toBe(OTHER_CALL);
      expect(card.checkAgain).toBe(false);
      expect(card.primary).toBe("citation-open");
    });

    // protects=#3005: only a Citation the press's check leaves out takes the line; fails_when=a typed Question's, this call's, or a press sent without the call's text takes it; no_claim=why those were left unchecked.
    test("any other: a typed Question's, this call's on a press's reply, or a button's name sent without the call keeps the general line", async () => {
      setLanguage(language);
      const general = t("citation.reason.notChecked");
      const cases = [
        { question: questionOf("What did they say last time?"), cited: "earlier", sent: true },
        { question: questionOf(press), cited: "this", sent: true },
        { question: questionOf(press), cited: "earlier", sent: false },
      ];
      for (const { question, cited, sent } of cases) {
        const card = await cardOf(question, answerCiting(notChecked(cited), sent));
        expect(card.badge).toContain(t("citation.badge.notChecked"));
        expect(card.reason).toBe(general);
        expect(card.checkAgain).toBe(true);
        expect(card.open).toBe(t("citation.open.time"));
        expect(card.primary).toBe("citation-check-again");
      }
    });
  });
}
