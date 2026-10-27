import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { Examples, Mind, Settings, Suggestion, SuggestionOutcome } from "../../src/core/api";

/*
 * What a pause asks the core, and when the offer to turn suggestions on shows
 * (#282): the window reaches the core through the bridge the preload exposes,
 * so a fake one stands in for it here.
 */

const suggestNext = vi.fn<(request: unknown) => Promise<SuggestionOutcome>>();
const updateSettings = vi.fn(async (patch: { device?: Partial<Settings["device"]> }) => ({
  ...settings(),
  device: { ...settings().device, ...patch.device },
}));
const bridge = {
  on: () => () => undefined,
  suggestNext,
  updateSettings,
};

let suggestions: typeof import("../../src/renderer/src/suggestions");
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: {},
  };
  suggestions = await import("../../src/renderer/src/suggestions");
  ({ useAppStore } = await import("../../src/renderer/src/store"));
});

const settings = (on = false, offers = 0) =>
  ({
    user: { language: "en", chatModel: null, suggestWhileWriting: on },
    device: {
      suggestionOffers: offers,
      gettingStarted: {
        started: false,
        citationChecked: false,
        mistakeSeen: false,
        indexed: false,
        askedOwn: false,
        askedReady: false,
        exported: false,
        hidden: false,
      },
    },
    language: "en",
  }) as unknown as Settings;

const mind = (id: string): Mind => ({
  id,
  title: id,
  autoTitle: "",
  kind: "mind",
  folderId: "folder",
  createdAt: "",
  updatedAt: "",
});

const TWO_SENTENCES =
  "The harbour survey depends on the tides. Spring tides come twice a month, near the full moon";

const suggestion = { suggestionId: "s", text: "They rise." } as Suggestion;

beforeEach(() => {
  suggestNext.mockReset();
  updateSettings.mockClear();
  suggestions.useSuggestionOffer.setState({ shown: null });
  useAppStore.setState({
    settings: settings(),
    minds: [mind("mind"), mind("second")],
    examples: null,
    otherExamples: [],
  });
});

const ask = (doc = new Y.Doc(), paragraph = TWO_SENTENCES) =>
  suggestions.askForSuggestion("mind", doc, { requestId: "r", paragraph });

describe("a pause while suggestions are off", () => {
  test("the first own note and examples wait, even with an export preference; the shared export milestone releases the offer", async () => {
    const one = settings();
    useAppStore.setState({
      settings: {
        ...one,
        user: {
          ...one.user,
          exportOptions: { ...one.user.exportOptions, citationPlace: "footnotes" },
        },
      },
      minds: [mind("mind"), mind("example")],
      examples: {
        group: "credit",
        available: true,
        mindId: "example",
        linkedFolderId: "examples",
        answerId: "example-answer",
        more: [],
        ready: null,
      } satisfies Examples,
    });
    suggestNext.mockResolvedValue({ kind: "off", scopeHasDocuments: true });
    expect(await ask()).toBeNull();
    expect(suggestNext).not.toHaveBeenCalled();
    const current = useAppStore.getState().settings;
    if (!current) throw new Error("Settings have not loaded.");
    useAppStore.setState({
      settings: {
        ...current,
        device: {
          ...current.device,
          gettingStarted: { ...current.device.gettingStarted, exported: true },
        },
      },
    });
    expect(await ask()).toBeNull();
    expect(suggestNext).toHaveBeenCalledOnce();
    expect(suggestions.useSuggestionOffer.getState().shown).toEqual({
      mindId: "mind",
      line: "offer",
    });
  });

  test("offers to turn them on once a few sentences are written in a Mind whose scope has Documents", async () => {
    suggestNext.mockResolvedValue({ kind: "off", scopeHasDocuments: true });

    expect(await ask()).toBeNull();

    // It asks with the Mind's own Search scope: its Folder.
    expect(suggestNext).toHaveBeenCalledWith({
      requestId: "r",
      mindId: "mind",
      paragraph: TWO_SENTENCES,
      scope: { folderIds: ["folder"], tagIds: [], documentIds: [] },
    });
    expect(suggestions.useSuggestionOffer.getState().shown).toEqual({
      mindId: "mind",
      line: "offer",
    });
    // Counted on this device: it shows at most twice.
    expect(updateSettings).toHaveBeenCalledWith({ device: { suggestionOffers: 1 } });
  });

  test("offers nothing when the User said Not now in that Mind while the pause's request was out", async () => {
    const doc = new Y.Doc();
    suggestNext.mockImplementation(async () => {
      suggestions.declineOffer(doc);
      return { kind: "off", scopeHasDocuments: true };
    });
    await ask(doc);
    expect(suggestions.useSuggestionOffer.getState().shown).toBeNull();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  test("offers nothing with no Documents to suggest from", async () => {
    suggestNext.mockResolvedValue({ kind: "off", scopeHasDocuments: false });
    await ask();
    expect(suggestions.useSuggestionOffer.getState().shown).toBeNull();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  test("asks nothing in a Mind where the User chose Not now, after two offers, or before a few sentences", async () => {
    const declined = new Y.Doc();
    suggestions.declineOffer(declined);
    expect(suggestions.offerDeclined(declined)).toBe(true);
    await ask(declined);

    useAppStore.setState({ settings: settings(false, suggestions.MAX_OFFERS) });
    await ask();

    useAppStore.setState({ settings: settings() });
    await ask(new Y.Doc(), "Only one sentence here, though it is long enough to be one");

    expect(suggestNext).not.toHaveBeenCalled();
  });
});

describe("a pause while suggestions are on", () => {
  test("gives the core's suggestion, and the line saying they are on goes", async () => {
    useAppStore.setState({ settings: settings(true) });
    suggestions.useSuggestionOffer.setState({ shown: { mindId: "mind", line: "on" } });
    suggestNext.mockResolvedValue({ kind: "suggestion", suggestion });

    expect(
      await ask(new Y.Doc(), "One long sentence about the tides at the harbour, unfinished"),
    ).toBe(suggestion);
    expect(suggestions.useSuggestionOffer.getState().shown).toBeNull();
  });
});

describe("the words a suggestion shows", () => {
  const offered = {
    suggestionId: "s",
    text: "They rise.",
    citation: {
      passageId: "passage-1",
      documentId: "tides",
      documentName: "Tides",
      contentHash: "v1",
      pageFrom: 2,
      pageTo: 2,
      location: { kind: "page", from: 2, to: 2 },
      quote: "Spring tides rise.",
    },
  } as unknown as Suggestion;
  const live = (name: string) =>
    [{ id: "tides", contentHash: "v1", name, title: null }] as unknown as ReturnType<
      typeof useAppStore.getState
    >["documents"];

  test("name the Document as it is named now, and as it was cited once it can't be found", () => {
    useAppStore.setState({ documents: live("Tides of the coast") });
    expect(suggestions.describeSuggestion(offered).citation).toBe(
      "From Tides of the coast, p. 2: “Spring tides rise.”",
    );

    useAppStore.setState({ documents: [] });
    expect(suggestions.describeSuggestion(offered).citation).toBe(
      "From Tides, p. 2: “Spring tides rise.”",
    );
  });
});
