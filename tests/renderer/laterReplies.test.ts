import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ChatProvider,
  CoreEventName,
  CoreEvents,
  Meeting,
  ReferenceImportResult,
  ResearchPlanResult,
  Settings,
} from "../../src/core/api";

/*
 * A reply that comes after something newer happened in the window doesn't put the older state
 * back (#2302): each test holds the core's reply, makes the newer change, then lets it come.
 */

const listeners = new Map<string, ((payload: unknown) => void)[]>();
const methods = new Map<string, ReturnType<typeof vi.fn>>();
const bridge = new Proxy(
  {
    on(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => undefined;
    },
  },
  {
    get(target, name: string) {
      if (name === "on") return target.on;
      let method = methods.get(name);
      if (!method) {
        method = vi.fn(async () => undefined);
        methods.set(name, method);
      }
      return method;
    },
  },
);

function emit<E extends CoreEventName>(event: E, payload: CoreEvents[E]) {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

const method = (name: string) => {
  (bridge as unknown as Record<string, unknown>)[name];
  return methods.get(name) as ReturnType<typeof vi.fn>;
};

/** Lets the promises already settled run on. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: {},
  };
});

afterAll(() => {
  (globalThis as unknown as { window: unknown }).window = undefined;
});

beforeEach(() => {
  for (const each of methods.values()) each.mockReset();
});

const imported = (importId: string, files: number): ReferenceImportResult => ({
  outcome: "imported",
  importId,
  format: "bibtex",
  total: 2,
  matched: 0,
  unmatched: 2,
  changed: 2,
  merged: 0,
  problems: [],
  entries: ["Tides", "Harbours"].map((title) => ({
    recordId: title,
    title,
    documentId: null,
    matchedBy: null,
    change: "added" as const,
  })),
  files,
});

describe("Importing references", () => {
  test.each(["dismissed", "replaced by another import"] as const)(
    "Add files doesn't bring back an import %s while the files were added",
    async (newer) => {
      const { useReferenceImport } = await import("../../src/renderer/src/referenceImport");
      method("importReferences").mockResolvedValue(imported("first", 2));
      method("listUnmatchedReferences").mockResolvedValue([]);
      await useReferenceImport.getState().importPath("/refs/tides.bib");
      const adding = Promise.withResolvers<void>();
      method("addImportedReferenceFiles").mockReturnValue(adding.promise);

      const added = useReferenceImport.getState().addFiles();
      if (newer === "dismissed") {
        useReferenceImport.getState().dismiss();
      } else {
        method("importReferences").mockResolvedValue(imported("second", 3));
        useReferenceImport.setState({ phase: "idle" });
        await useReferenceImport.getState().importPath("/refs/harbours.ris");
      }
      adding.resolve();
      await added;

      expect(useReferenceImport.getState().result).toEqual(
        newer === "dismissed" ? null : imported("second", 3),
      );
    },
  );

  test("Add files says the files are added when the import is still shown", async () => {
    const { useReferenceImport } = await import("../../src/renderer/src/referenceImport");
    method("importReferences").mockResolvedValue(imported("first", 2));
    method("listUnmatchedReferences").mockResolvedValue([]);
    await useReferenceImport.getState().importPath("/refs/tides.bib");

    await useReferenceImport.getState().addFiles();

    expect(useReferenceImport.getState().result).toEqual(imported("first", 0));
  });
});

describe("Research", () => {
  test("a cancelled plan's failure doesn't write over the card asked again", async () => {
    vi.useFakeTimers();
    try {
      const research = await import("../../src/renderer/src/research");
      const first = Promise.withResolvers<ResearchPlanResult>();
      const second = Promise.withResolvers<ResearchPlanResult>();
      method("planResearch").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      research.openResearch("mind", "Tide tables", null, false);
      research.cancelResearch("mind");
      // Asked again within the same millisecond: the two cards are told apart all the same.
      research.openResearch("mind", "Tide tables in winter", null, false);
      first.reject(new Error("The model couldn't be reached."));
      await settle();

      expect(research.useResearch.getState().plans.mind).toMatchObject({
        topic: "Tide tables in winter",
        planning: true,
        steps: [],
      });
      second.resolve({
        planned: true,
        plan: { title: "Winter tides", steps: ["Read the tables"] },
      });
      await settle();
      expect(research.useResearch.getState().plans.mind).toMatchObject({
        planning: false,
        steps: ["Read the tables"],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

const meeting = (microphonePausedAtMs: number | null, status = "recording"): Meeting =>
  ({
    id: "meeting",
    mindId: "mind",
    status,
    recordedMs: 60_000,
    recordingSince: null,
    microphonePausedAtMs,
  }) as unknown as Meeting;

describe("Meetings", () => {
  test("a refused microphone switch doesn't put back a Meeting older than the core's", async () => {
    const { useMeetings } = await import("../../src/renderer/src/meetings");
    useMeetings.setState({ meetings: [meeting(null)] });
    const switching = Promise.withResolvers<void>();
    method("setMeetingMicrophone").mockReturnValue(switching.promise);

    const paused = useMeetings.getState().setMicrophonePaused("meeting", true);
    expect(useMeetings.getState().meetings[0]?.microphonePausedAtMs).toBe(60_000);
    const stopped = meeting(null, "stopped");
    emit("meetings.changed", [stopped]);
    switching.reject(new Error("The microphone couldn't be switched."));
    await paused;

    expect(useMeetings.getState().meetings).toEqual([stopped]);
    expect(useMeetings.getState().problems.meeting).toBeDefined();
  });

  test("a refused microphone switch puts back the Meeting as it was", async () => {
    const { useMeetings } = await import("../../src/renderer/src/meetings");
    const before = meeting(null);
    useMeetings.setState({ meetings: [before] });
    method("setMeetingMicrophone").mockRejectedValue(new Error("No microphone."));

    await useMeetings.getState().setMicrophonePaused("meeting", true);

    expect(useMeetings.getState().meetings).toEqual([before]);
  });
});

const provider = (id: string, kind: ChatProvider["kind"]) => ({ id, kind }) as ChatProvider;

describe("Signing in from Settings keeps the default model", () => {
  test.each(["claude-account", "copilot", "chatgpt"] as const)(
    "a model chosen while the %s provider is saved stays the default",
    async (kind) => {
      const { useAppStore } = await import("../../src/renderer/src/store");
      const before = { providerId: "openai", modelId: "gpt-5.4-mini" };
      const chosen = { providerId: "openai", modelId: "gpt-5.5" };
      useAppStore.setState({ settings: { user: { chatModel: before } } as unknown as Settings });
      const saving = Promise.withResolvers<ChatProvider>();
      method("listChatProviders").mockResolvedValue([]);
      method("saveChatProvider").mockReturnValue(saving.promise);
      method("updateSettings").mockImplementation(async (patch) => ({
        user: { chatModel: patch.user.chatModel },
      }));
      method("getClaudeAccount").mockResolvedValue({ account: { state: "signed-in" } });
      method("getCopilot").mockResolvedValue({ models: [{ id: "gpt-5.5" }] });
      method("getChatGptPlan").mockResolvedValue({
        account: { state: "signed-in" },
        models: [{ id: "gpt-6.1-sol" }],
      });

      const signedIn =
        kind === "copilot"
          ? (await import("../../src/renderer/src/copilotSignIn")).chooseCopilotPlan({
              keepDefault: true,
            })
          : kind === "chatgpt"
            ? (await import("../../src/renderer/src/chatGptSignIn"))
                .continueWithChatGpt({ keepDefault: true })
                .then((result) => result !== null && !("kind" in result))
            : (await import("../../src/renderer/src/claudeSignIn")).signInWithClaude({
                keepDefault: true,
              });
      await vi.waitFor(() => expect(method("saveChatProvider")).toHaveBeenCalled());
      await useAppStore.getState().updateSettings({ user: { chatModel: chosen } });
      saving.resolve(provider("plan", kind));
      expect(await signedIn).toBe(true);

      expect(method("updateSettings").mock.calls).toEqual([[{ user: { chatModel: chosen } }]]);
      expect(method("saveChatProvider")).toHaveBeenCalledWith(
        expect.objectContaining({ kind, keepDefault: true }),
      );
    },
  );

  test("the Copilot provider removed while it was saved isn't said to be saved", async () => {
    const { useCopilot, chooseCopilotPlan } = await import("../../src/renderer/src/copilotSignIn");
    const saving = Promise.withResolvers<ChatProvider>();
    method("listChatProviders").mockResolvedValue([]);
    method("saveChatProvider").mockReturnValue(saving.promise);
    method("getCopilot").mockResolvedValue({ models: [{ id: "gpt-5.5" }] });

    const signedIn = chooseCopilotPlan();
    await vi.waitFor(() => expect(method("saveChatProvider")).toHaveBeenCalled());
    // Removed in Settings › Models before the save's reply came: the core lists none.
    saving.resolve(provider("plan", "copilot"));
    await signedIn;

    expect(useCopilot.getState().providerSaved).toBe(false);
  });

  test("an older list of providers doesn't say whether Copilot's is saved over a newer one", async () => {
    const { useCopilot } = await import("../../src/renderer/src/copilotSignIn");
    const older = Promise.withResolvers<ChatProvider[]>();
    method("listChatProviders").mockReturnValueOnce(older.promise).mockResolvedValueOnce([]);

    // Saved, then removed: each changes the readiness, and each reads the providers again.
    emit("chatReadiness.changed", { ready: true } as CoreEvents["chatReadiness.changed"]);
    emit("chatReadiness.changed", { ready: false, reason: "no-provider" });
    await settle();
    older.resolve([provider("plan", "copilot")]);
    await settle();

    expect(useCopilot.getState().providerSaved).toBe(false);
  });
});
