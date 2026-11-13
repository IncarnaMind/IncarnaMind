import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "ai";
import { describe, expect, test } from "vitest";
import {
  COMMON_FIELDS,
  createAiSdkChatModel,
  InvalidInputError,
  USAGE_EVENTS,
  type UsageDataSender,
  type UsageEventFields,
  type UsageEventMessage,
} from "../../src/core";
import { createEventHub } from "../../src/core/events";
import { spendRange } from "../../src/core/modelSpend";
import {
  BUILT_IN_SKILL_NAMES,
  InvalidUsageEventError,
  parseUsageEvent,
  SETTINGS_PAGES,
  UI_USAGE_EVENTS,
  type UsageEvent,
  type UsageField,
} from "../../src/core/usageEvents";
import { trackUsage } from "../../src/core/usageTracking";
import { settingsPages } from "../../src/renderer/src/settingsPages";
import { createFakeBrowser, startFakeOpenAI } from "../helpers/chatgpt";
import {
  answerEnded,
  askAndFinish,
  citingModel,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { createTempDataFolder, manualClock, nextEvent, startCore } from "../helpers/core";
import { linkAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModel, unscripted } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const root = join(__dirname, "../..");

/** A sender that records what the core asks of it, as the desktop app's PostHog sender would get it. */
function fakeSender({ testerBuild = false } = {}) {
  const switched: boolean[] = [];
  const sent: UsageEventMessage[] = [];
  const sender: UsageDataSender = {
    service: { id: "https://analytics.example.com", name: "PostHog (analytics.example.com)" },
    testerBuild,
    appVersion: "1.2.3",
    setEnabled: (enabled) => {
      switched.push(enabled);
    },
    capture: (message) => {
      sent.push(message);
    },
  };
  return { sender, switched, sent };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TIDES = buildPdf([
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);
const SPRING = "Spring tides happen at new moon and at full moon.";

const first = (passages: ShownPassage[]) => {
  const passage = passages[0];
  if (!passage) throw new Error("The search showed no Passages.");
  return passage;
};

/** A model that searches, cites the first Passage it was shown, and answers. */
const springModel = () =>
  citingModel({
    query: "spring tides",
    records: (passages) => [
      { marker: 1, passage: first(passages).id, pageFrom: 1, pageTo: 1, quote: SPRING },
    ],
    answer: "Spring tides come at new and full moon [^1].",
  });

/**
 * Does what a User does that leads to usage events: a Mind, files added, a
 * folder linked, a Question asked and answered with a Citation, an export,
 * and the interface's events. Returns the Answer's id.
 */
async function useTheApp(sender: UsageDataSender, agree: boolean | null) {
  const setUp = await setUpWithDocuments(springModel(), [{ name: "Tides.pdf", contents: TIDES }], {
    usageData: sender,
  });
  const { core, client, mind } = setUp;
  if (agree !== null) await core.updatePrivacySettings({ usageData: agree });
  await core.createMind({ title: "Harbour" });
  const sources = await createTempDataFolder();
  await core.addDocuments([await writeSourceFile(sources, "Notes.md", "# Notes\n\nHigh water.\n")]);
  const linked = await createTempDataFolder();
  await writeSourceFile(linked, "Tables.txt", "Tide tables give the times of high water.\n");
  await linkAndProcess(core, linked);
  const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
  await core.exportMind(mind.id, { format: "markdown" });
  await core.recordUsage({ event: "citation_opened", fields: { check: "found" } });
  await core.recordUsage({ event: "settings_page_viewed", fields: { page: "privacy" } });
  await core.recordUsage({ event: "example_opened", fields: { group: "contracts" } });
  return { ...setUp, answerId };
}

const fieldsOf = (sent: readonly UsageEventMessage[], event: string) =>
  sent.filter((message) => message.event === event).map((message) => message.properties);

describe("Usage data: consent", { timeout: 30_000 }, () => {
  test("a copy built without an analytics project sends nothing, asks nothing and lists nothing", async () => {
    const core = startCore(await createTempDataFolder());

    expect((await core.getPrivacySettings()).usageData).toEqual({
      available: false,
      enabled: false,
      testerBuild: false,
      asked: false,
      localMode: false,
    });
    await expect(core.updatePrivacySettings({ usageData: true })).rejects.toThrow(
      InvalidInputError,
    );
    await expect(core.updatePrivacySettings({ usageData: false })).rejects.toThrow(
      InvalidInputError,
    );
    // The interface's events are still checked, and go nowhere.
    await core.recordUsage({ event: "settings_page_viewed", fields: { page: "general" } });
    expect((await core.listNetworkTraffic()).map((traffic) => traffic.id)).not.toContain(
      "usage-data",
    );
  });

  test("with consent off, no event is sent, whatever the User does", async () => {
    const { sender, switched, sent } = fakeSender();
    const { core } = await useTheApp(sender, null);

    // Not asked yet: off, the default.
    expect((await core.getPrivacySettings()).usageData).toEqual({
      available: true,
      enabled: false,
      testerBuild: false,
      asked: false,
      localMode: false,
    });
    expect(sent).toEqual([]);
    expect(switched).not.toContain(true);

    // Declined: asked, and still nothing.
    const declined = nextEvent(core, "privacy.changed");
    await core.updatePrivacySettings({ usageData: false });
    expect((await declined).usageData).toMatchObject({ enabled: false, asked: true });
    await core.createMind();
    await core.recordUsage({ event: "citation_opened", fields: { check: "found" } });
    expect(sent).toEqual([]);
    expect(switched).not.toContain(true);
    // Listed on the Privacy page, off.
    expect(
      (await core.listNetworkTraffic()).find((traffic) => traffic.id === "usage-data"),
    ).toEqual({
      id: "usage-data",
      service: { id: "https://analytics.example.com", name: "PostHog (analytics.example.com)" },
      enabled: false,
    });
  });

  test("with consent on, each event carries exactly its declared fields and the common ones", async () => {
    const { sender, switched, sent } = fakeSender();
    const { core } = await useTheApp(sender, true);
    expect(switched).toEqual([true]);
    expect((await core.getPrivacySettings()).usageData).toMatchObject({
      enabled: true,
      asked: true,
    });

    expect(sent.length).toBeGreaterThan(0);
    const installId = sent[0]?.installId;
    expect(installId).toMatch(UUID);
    for (const message of sent) {
      expect(message.installId).toBe(installId);
      expect(Object.keys(message.properties).sort()).toEqual(
        [...Object.keys(USAGE_EVENTS[message.event]), ...Object.keys(COMMON_FIELDS)].sort(),
      );
      // Every value fits the catalog.
      const fields = Object.fromEntries(
        Object.keys(USAGE_EVENTS[message.event]).map((key) => [key, message.properties[key]]),
      );
      expect(() => parseUsageEvent(message.event, fields)).not.toThrow();
      expect(message.properties).toMatchObject({
        app_version: "1.2.3",
        build: "release",
        os: expect.stringMatching(/^(darwin|win32|linux|other)$/),
        arch: expect.stringMatching(/^(arm64|x64|other)$/),
      });
    }

    expect(fieldsOf(sent, "mind_created")).toHaveLength(1);
    expect(fieldsOf(sent, "documents_added")).toEqual([
      expect.objectContaining({ documents: 1, already_added: 0, skipped: 0, markdown: 1, pdf: 0 }),
    ]);
    expect(fieldsOf(sent, "folder_linked")).toHaveLength(1);
    expect(fieldsOf(sent, "question_asked")).toEqual([
      expect.objectContaining({ provider: "ollama", local: true }),
    ]);
    expect(fieldsOf(sent, "answer_finished")).toEqual([
      expect.objectContaining({
        outcome: "done",
        citations: 1,
        found: 1,
        not_found: 0,
        cant_check: 0,
        duration_ms: expect.any(Number),
      }),
    ]);
    expect(fieldsOf(sent, "mind_exported")).toEqual([
      expect.objectContaining({ format: "markdown", questions: true }),
    ]);
    expect(fieldsOf(sent, "citation_opened")).toEqual([
      expect.objectContaining({ check: "found" }),
    ]);
    expect(fieldsOf(sent, "settings_page_viewed")).toEqual([
      expect.objectContaining({ page: "privacy" }),
    ]);
    expect(fieldsOf(sent, "example_opened")).toEqual([
      expect.objectContaining({ group: "contracts" }),
    ]);

    // Nothing the User wrote or named appears anywhere in what was sent.
    const everything = JSON.stringify(sent);
    for (const text of ["Tides", "Harbour", "Notes", "spring tides", "Spring", "High water"]) {
      expect(everything).not.toContain(text);
    }
  });

  test("turning it off stops sending at once, and nothing more is sent", async () => {
    const { sender, switched, sent } = fakeSender();
    const core = startCore(await createTempDataFolder(), { usageData: sender });
    await core.updatePrivacySettings({ usageData: true });
    await core.createMind();
    expect(fieldsOf(sent, "mind_created")).toHaveLength(1);

    const off = core.updatePrivacySettings({ usageData: false });
    // Stopped before the call even returns: the sender drops what it has queued.
    expect(switched).toEqual([true, false]);
    expect((await off).usageData.enabled).toBe(false);
    const before = sent.length;
    await core.createMind();
    await core.recordUsage({ event: "settings_page_viewed", fields: { page: "general" } });
    expect(sent).toHaveLength(before);
  });

  test("the choice is kept: agreeing starts sending with the next launch, declining never does", async () => {
    const dataDir = await createTempDataFolder();
    const first = fakeSender();
    const core = startCore(dataDir, { usageData: first.sender });
    await core.updatePrivacySettings({ usageData: true });
    await core.createMind();
    core.close();

    const again = fakeSender();
    startCore(dataDir, { usageData: again.sender });
    expect(again.switched).toEqual([true]);
    // Sent at once: the app was opened, in the interface's language, under the same ID.
    expect(again.sent.map((message) => message.event)).toEqual(["app_opened"]);
    expect(again.sent[0]?.properties).toMatchObject({ language: "en" });
    expect(again.sent[0]?.installId).toBe(first.sent[0]?.installId);

    const declinedDir = await createTempDataFolder();
    const declining = startCore(declinedDir, { usageData: fakeSender().sender });
    await declining.updatePrivacySettings({ usageData: false });
    declining.close();
    const later = fakeSender();
    const reopened = startCore(declinedDir, { usageData: later.sender });
    expect(later.switched).toEqual([]);
    expect(later.sent).toEqual([]);
    expect((await reopened.getPrivacySettings()).usageData).toMatchObject({
      enabled: false,
      asked: true,
    });
  });

  test("a test build sends until the User says no, and remembers when they do", async () => {
    const dataDir = await createTempDataFolder();
    const tester = fakeSender({ testerBuild: true });
    const core = startCore(dataDir, { usageData: tester.sender });

    expect(tester.switched).toEqual([true]);
    expect(tester.sent.map((message) => message.event)).toEqual(["app_opened"]);
    expect(tester.sent[0]?.properties).toMatchObject({ build: "tester" });
    // The first run's notice is still to show.
    expect((await core.getPrivacySettings()).usageData).toEqual({
      available: true,
      enabled: true,
      testerBuild: true,
      asked: false,
      localMode: false,
    });

    await core.updatePrivacySettings({ usageData: false });
    expect(tester.switched).toEqual([true, false]);
    core.close();

    const again = fakeSender({ testerBuild: true });
    const reopened = startCore(dataDir, { usageData: again.sender });
    expect(again.switched).toEqual([]);
    expect(again.sent).toEqual([]);
    expect((await reopened.getPrivacySettings()).usageData).toMatchObject({
      enabled: false,
      asked: true,
    });
  });

  test("local mode turns usage data off, and it stays off", async () => {
    const { sender, switched, sent } = fakeSender({ testerBuild: true });
    const core = startCore(await createTempDataFolder(), { usageData: sender });
    expect(switched).toEqual([true]);

    const changed = nextEvent(core, "privacy.changed");
    await core.setLocalOnly(true);
    expect(switched).toEqual([true, false]);
    expect((await changed).usageData).toMatchObject({ enabled: false, localMode: true });
    const before = sent.length;
    await core.createMind();
    expect(sent).toHaveLength(before);
    // It can't be turned on while local mode is on.
    await expect(core.updatePrivacySettings({ usageData: true })).rejects.toMatchObject({
      name: "InvalidInputError",
      wording: { key: "error.privacy.usageDataLocalMode" },
    });
    expect(
      (await core.listNetworkTraffic()).find((each) => each.id === "usage-data"),
    ).toMatchObject({ enabled: false });

    // Local mode off again: usage data stays off until the User turns it on.
    await core.setLocalOnly(false);
    expect((await core.getPrivacySettings()).usageData).toMatchObject({
      enabled: false,
      localMode: false,
    });
    expect(switched).toEqual([true, false]);
    await core.updatePrivacySettings({ usageData: true });
    expect(switched).toEqual([true, false, true]);
  });

  test("resetting the install ID sends future events under a new one, kept from then on", async () => {
    const dataDir = await createTempDataFolder();
    const { sender, sent } = fakeSender();
    const core = startCore(dataDir, { usageData: sender });
    await core.updatePrivacySettings({ usageData: true });
    await core.recordUsage({ event: "settings_page_viewed", fields: { page: "privacy" } });
    const old = sent.at(-1)?.installId;

    await core.resetUsageInstallId();
    await core.recordUsage({ event: "settings_page_viewed", fields: { page: "privacy" } });
    const renewed = sent.at(-1)?.installId;

    expect(old).toMatch(UUID);
    expect(renewed).toMatch(UUID);
    expect(renewed).not.toBe(old);
    core.close();

    const again = fakeSender();
    startCore(dataDir, { usageData: again.sender });
    expect(again.sent[0]?.installId).toBe(renewed);
  });
});

describe("Usage data: the events", () => {
  test("no field can hold free text: the types refuse it, and so does the check at runtime", async () => {
    // Free text doesn't type-check in any field.
    const page: UsageEventFields<"settings_page_viewed"> = {
      // @ts-expect-error: a page is one of the Settings pages, not any text.
      page: "My tax return.pdf",
    };
    const asked: UsageEventFields<"question_asked"> = {
      // @ts-expect-error: a provider is a kind of provider, not a Question.
      provider: "What did the board decide?",
      local: false,
    };
    const exported: UsageEventFields<"mind_exported"> = {
      format: "docx",
      questions: true,
      // @ts-expect-error: an export has no field for a Mind's title.
      title: "Board minutes",
    };
    void [page, asked, exported];

    const rejected: [string, unknown][] = [
      // Text that isn't one of the field's values: a Document's name, a Question, a Folder, a path.
      ["settings_page_viewed", { page: "My tax return.pdf" }],
      ["question_asked", { provider: "What did the board decide?", local: false }],
      ["error_occurred", { area: "document", kind: "/Users/alice/Contracts/NDA.docx" }],
      ["skill_used", { skill: "my-secret-skill", forced: false }],
      // A field that isn't declared, e.g. to carry a name or a quote.
      ["citation_opened", { check: "found", quote: "Spring tides happen at new moon." }],
      ["mind_created", { title: "Board minutes" }],
      ["folder_linked", { name: "Clients" }],
      // Text, or anything but a whole number, in a count; text in a flag.
      ["documents_added", { ...counts(), documents: "Tides.pdf" }],
      ["documents_added", { ...counts(), documents: 1.5 }],
      ["documents_added", { ...counts(), documents: -1 }],
      ["question_asked", { provider: "ollama", local: "yes" }],
      // A field left out, an object that isn't one, and an unknown event.
      ["question_asked", { provider: "ollama" }],
      ["citation_opened", "found"],
      ["document_named", { name: "Tides.pdf" }],
    ];
    for (const [event, fields] of rejected) {
      expect(() => parseUsageEvent(event, fields), `${event} ${JSON.stringify(fields)}`).toThrow(
        InvalidUsageEventError,
      );
    }

    // The interface's events are checked the same way, whether or not usage data is on…
    const core = startCore(await createTempDataFolder(), { usageData: fakeSender().sender });
    await expect(
      core.recordUsage({
        event: "settings_page_viewed",
        fields: { page: "My tax return.pdf" },
      } as never),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.recordUsage({
        event: "citation_opened",
        fields: { check: "found", quote: "Spring tides" },
      } as never),
    ).rejects.toThrow(InvalidInputError);
    // …and the interface can only send its own.
    await expect(
      core.recordUsage({ event: "app_opened", fields: { language: "en" } } as never),
    ).rejects.toThrow(InvalidInputError);
  });

  test("every field is one of a closed list, a count or a flag", () => {
    for (const [event, fields] of Object.entries(USAGE_EVENTS)) {
      for (const [name, field] of Object.entries(fields as Record<string, UsageField>)) {
        expect(["one-of", "count", "flag"], `${event}.${name}`).toContain(field.kind);
        expect(name, `${event}.${name}`).toMatch(/^[a-z_]+$/);
        if (field.kind === "one-of") {
          expect(field.values.length).toBeGreaterThan(0);
          for (const value of field.values) expect(value).toMatch(/^[a-z0-9_-]+$|^zh-CN$/);
        }
      }
    }
    for (const event of UI_USAGE_EVENTS) expect(Object.keys(USAGE_EVENTS)).toContain(event);
  });

  test("the lists of Settings pages and built-in Skills are the app's", () => {
    expect([...SETTINGS_PAGES]).toEqual([...settingsPages]);
    const builtIn = readdirSync(join(root, "resources/skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect([...BUILT_IN_SKILL_NAMES].sort()).toEqual(builtIn);
  });

  test("docs/privacy.md lists every event and every field", () => {
    const doc = readFileSync(join(root, "docs/privacy.md"), "utf8");
    for (const [event, fields] of Object.entries(USAGE_EVENTS)) {
      expect(doc, event).toContain(`\`${event}\``);
      for (const name of Object.keys(fields))
        expect(doc, `${event}.${name}`).toContain(`\`${name}\``);
    }
    for (const name of Object.keys(COMMON_FIELDS)) expect(doc, name).toContain(`\`${name}\``);
  });
});

function counts(): UsageEventFields<"documents_added"> {
  return {
    documents: 0,
    already_added: 0,
    skipped: 0,
    pdf: 0,
    docx: 0,
    pptx: 0,
    xlsx: 0,
    csv: 0,
    markdown: 0,
    text: 0,
    image: 0,
    rtf: 0,
    html: 0,
    web: 0,
    transcript: 0,
  };
}

describe("Usage data: what the core derives from its events", () => {
  /** Tracks a bare event hub, with fixed lookups, and returns what would be sent. */
  function track() {
    const events = createEventHub();
    const recorded: UsageEvent[] = [];
    let time = 1_000;
    let questions = 0;
    trackUsage(events, (event) => recorded.push(event), {
      chatProvider: (id) => (id === "cloud" ? { kind: "anthropic", local: false } : null),
      connectorIsRemote: (id) => (id === "gone" ? null : id === "remote"),
      skillIsBuiltIn: (name) => name === "summarise-document",
      now: () => time,
      answerStarted: () => {
        questions++;
      },
    });
    return {
      events,
      recorded,
      questions: () => questions,
      advance: (ms: number) => {
        time += ms;
      },
    };
  }

  const model = { providerId: "cloud", modelId: "claude" };
  const call = (input: Partial<import("../../src/core").AnswerToolCall>) => ({
    id: "call",
    tool: "search_documents",
    source: "documents" as const,
    input: {},
    status: "done" as const,
    resultCount: null,
    ...input,
  });

  test("an Answer: its model's kind, how long it took, and each Connector and Skill once, never by the User's names", () => {
    const { events, recorded, questions, advance } = track();
    const ids = { mindId: "m", answerId: "a" };
    events.emit("answer.started", { ...ids, questionId: "q", model });
    for (const remote of ["remote", "remote", "local", "gone"]) {
      events.emit("answer.toolCallFinished", {
        ...ids,
        call: call({
          tool: "search_issues",
          source: "connector",
          connector: { id: remote, name: "Acme CRM" },
        }),
      });
    }
    // A denied or failed call wasn't used.
    events.emit("answer.toolCallFinished", {
      ...ids,
      call: call({ source: "connector", connector: { id: "other", name: "X" }, status: "failed" }),
    });
    for (const name of ["summarise-document", "my-client-letters", "summarise-document"]) {
      events.emit("answer.toolCallFinished", {
        ...ids,
        call: call({
          tool: "use_skill",
          source: "skill",
          input: { name },
          forced: name !== "summarise-document",
        }),
      });
    }
    advance(4_200);
    events.emit("answer.finished", {
      ...ids,
      status: "stopped",
      citations: [],
      droppedMarkers: 0,
      droppedRecords: 0,
      rejectedRecords: [],
      idsAsText: 0,
      placedMarkers: 0,
      citedAfterChecking: { count: 0, asked: false },
      citationSupport: null,
      quoteRetry: null,
      figures: [],
      analyses: [],
      uncalculated: 0,
      figureRetry: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
    });

    expect(recorded).toEqual([
      { event: "question_asked", fields: { provider: "anthropic", local: false } },
      { event: "connector_used", fields: { remote: true } },
      { event: "connector_used", fields: { remote: false } },
      { event: "skill_used", fields: { skill: "summarise-document", forced: false } },
      { event: "skill_used", fields: { skill: "own", forced: true } },
      {
        event: "answer_finished",
        fields: {
          outcome: "stopped",
          duration_ms: 4_200,
          citations: 0,
          found: 0,
          not_found: 0,
          cant_check: 0,
        },
      },
    ]);
    expect(JSON.stringify(recorded)).not.toMatch(/Acme|my-client-letters|claude/);
    expect(questions()).toBe(1);
  });

  test("errors, by kind only: a failed Answer, a Document that fails now, a Connector that goes wrong", () => {
    const { events, recorded } = track();
    events.emit("answer.failed", {
      mindId: "m",
      answerId: "a",
      error: { kind: "rate-limit", message: "Slow down, alice@example.com" },
    });
    const document = (status: string, reason?: string) =>
      ({
        id: "d",
        status,
        ...(reason && { failure: { reason, message: "/Users/alice/NDA.docx is broken" } }),
      }) as unknown as import("../../src/core").Document;
    // Seen failed from an earlier run: not new.
    events.emit("document.status", document("failed", "unreadable"));
    events.emit("document.status", { ...document("queued"), id: "e" } as never);
    events.emit("document.status", {
      ...document("failed", "password-protected"),
      id: "e",
    } as never);
    const connector = (state: string, kind?: string) =>
      ({
        id: "c",
        state,
        ...(kind && { error: { kind } }),
      }) as unknown as import("../../src/core").Connector;
    events.emit("connectors.changed", [connector("running")]);
    events.emit("connectors.changed", [connector("error", "timed-out")]);
    events.emit("connectors.changed", [connector("error", "timed-out")]);

    expect(recorded).toEqual([
      { event: "error_occurred", fields: { area: "answer", kind: "rate-limit" } },
      { event: "error_occurred", fields: { area: "document", kind: "password-protected" } },
      { event: "error_occurred", fields: { area: "connector", kind: "timed-out" } },
    ]);
  });
});

describe("Usage data: a week's model spend (#1993)", { timeout: 30_000 }, () => {
  const HAIKU = "claude-haiku-5-5";
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  /** Tuesday, so a week added later lands in the next calendar week on any time zone. */
  const TUESDAY = "2026-10-13T12:00:00.000Z";
  const okModel = () =>
    scriptedModel(() => ({ text: "OK" }), {
      // The Answer's change-claim check reads a JSON verdict; "OK" would be logged as unreadable.
      generate: (call) =>
        call.question === "claimed-changes"
          ? { text: '{"claims":[]}' }
          : call.question === "request-done"
            ? { text: '{"asks_change":"no","request":"none"}' }
            : call.question
              ? unscripted(call.question, call.system)
              : { text: "OK" },
      judgesItsAnswers: true,
    });

  test("an own key and a subscription sign-in: its range, route, provider kind and counts", async () => {
    const clock = manualClock(TUESDAY);
    const fake = await startFakeOpenAI({ now: () => clock.now().getTime() });
    const dataDir = await createTempDataFolder();
    const { sender } = fakeSender();
    const core = startCore(dataDir, {
      browser: createFakeBrowser(fake),
      now: clock.now,
      createChatModel: (spec) => (spec.kind === "chatgpt" ? createAiSdkChatModel(spec) : okModel()),
      chatGptPlan: fake.endpoints,
      usageData: sender,
    });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.updatePrivacySettings({ usageData: true });
    expect((await core.signInToChatGpt()).ok).toBe(true);
    const plan = await core.saveChatProvider({ kind: "chatgpt", modelId: "gpt-6-luna" });
    const own = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: HAIKU,
    });
    if (own.service) await core.allowDataFlow("chat", own.service.id);

    for (const provider of [plan, own]) {
      const { model } = await core.prepareChatModel({
        providerId: provider.id,
        modelId: provider.kind === "chatgpt" ? "gpt-6-luna" : HAIKU,
      });
      await generateText({ model, prompt: "What is attention?", maxRetries: 0 });
    }
    // The own key's Question (its Answer is sent to its default model) and two sentences checked.
    const mind = await core.createMind({ title: "Tide notes" });
    const asked = await core.askInConversation({
      text: "When are spring tides?",
      mindId: mind.id,
    });
    if (!asked.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(core, asked.answerId);
    await core.recordAiUse([
      { mindId: mind.id, kind: "sentence-checked", characters: 0 },
      { mindId: mind.id, kind: "sentence-checked", characters: 0 },
    ]);
    core.close();

    clock.advance(WEEK_MS);
    const again = fakeSender();
    startCore(dataDir, {
      browser: createFakeBrowser(fake),
      now: clock.now,
      createChatModel: () => okModel(),
      chatGptPlan: fake.endpoints,
      usageData: again.sender,
    });

    const [week] = fieldsOf(again.sent, "model_spend_week");
    expect(week).toEqual(
      expect.objectContaining({
        spend_range: "under_1",
        route: "mixed",
        provider_kind: "anthropic",
        questions: 1,
        checks: 2,
      }),
    );
    // Its declared fields and the common ones, and nothing else.
    expect(Object.keys(week ?? {}).sort()).toEqual(
      [...Object.keys(USAGE_EVENTS.model_spend_week), ...Object.keys(COMMON_FIELDS)].sort(),
    );
  });

  test("a model on this computer: the range is 0, the route local and the provider kind ollama", async () => {
    const clock = manualClock(TUESDAY);
    const dataDir = await createTempDataFolder();
    const { sender } = fakeSender();
    const core = startCore(dataDir, {
      now: clock.now,
      createChatModel: () => okModel(),
      usageData: sender,
    });
    await core.updatePrivacySettings({ usageData: true });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
    const { model } = await core.prepareChatModel({
      providerId: provider.id,
      modelId: "qwen3.5:4b",
    });
    await generateText({ model, prompt: "Hello", maxRetries: 0 });
    core.close();

    clock.advance(WEEK_MS);
    const again = fakeSender();
    startCore(dataDir, {
      now: clock.now,
      createChatModel: () => okModel(),
      usageData: again.sender,
    });

    expect(fieldsOf(again.sent, "model_spend_week")).toEqual([
      expect.objectContaining({
        spend_range: "0",
        route: "local",
        provider_kind: "ollama",
        questions: 0,
        checks: 0,
      }),
    ]);
  });

  test("a week with no model call, or with usage data off, or in Local mode, sends nothing", async () => {
    /** A fresh data folder, optionally with one local model call, started again a week later. */
    const week = async (call: boolean, consent: "on" | "off", localMode: boolean) => {
      const clock = manualClock(TUESDAY);
      const dataDir = await createTempDataFolder();
      const { sender } = fakeSender();
      const core = startCore(dataDir, {
        now: clock.now,
        createChatModel: () => okModel(),
        usageData: sender,
      });
      if (consent === "on") await core.updatePrivacySettings({ usageData: true });
      if (localMode) await core.setLocalOnly(true);
      if (call) {
        const provider = await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
        const { model } = await core.prepareChatModel({
          providerId: provider.id,
          modelId: "qwen3.5:4b",
        });
        await generateText({ model, prompt: "Hello", maxRetries: 0 });
      }
      core.close();

      clock.advance(WEEK_MS);
      const again = fakeSender();
      startCore(dataDir, {
        now: clock.now,
        createChatModel: () => okModel(),
        usageData: again.sender,
      });
      return again;
    };

    // No model call at all.
    expect(fieldsOf((await week(false, "on", false)).sent, "model_spend_week")).toEqual([]);
    // A model call, but the week is sent only while the User agrees.
    expect(fieldsOf((await week(true, "off", false)).sent, "model_spend_week")).toEqual([]);
    expect(fieldsOf((await week(true, "on", true)).sent, "model_spend_week")).toEqual([]);
  });

  test("turning usage data on after a week ended sends nothing from that week", async () => {
    const clock = manualClock(TUESDAY);
    const dataDir = await createTempDataFolder();
    const { sender, sent } = fakeSender();
    const core = startCore(dataDir, {
      now: clock.now,
      createChatModel: () => okModel(),
      usageData: sender,
    });

    // One model call while usage data is off.
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
    const { model } = await core.prepareChatModel({
      providerId: provider.id,
      modelId: "qwen3.5:4b",
    });
    await generateText({ model, prompt: "Hello", maxRetries: 0 });

    // The app stays open across the week boundary, and only then does the User agree.
    clock.advance(WEEK_MS);
    await core.updatePrivacySettings({ usageData: true });

    // The first Question of the new week checks for a completed week: it must not send the one before.
    const mind = await core.createMind({ title: "Tide notes" });
    const asked = await core.askInConversation({ text: "Hello", mindId: mind.id });
    if (!asked.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(core, asked.answerId);

    // Usage data is flowing in the new week, so the empty week above is not an unwired test.
    expect(sent.map((message) => message.event)).toContain("question_asked");
    expect(fieldsOf(sent, "model_spend_week")).toEqual([]);
  });

  test("the week usage data is turned on in counts only from that moment", async () => {
    const clock = manualClock("2026-10-13T11:00:00.000Z");
    const dataDir = await createTempDataFolder();
    const { sender } = fakeSender();
    const core = startCore(dataDir, {
      now: clock.now,
      createChatModel: () => okModel(),
      usageData: sender,
    });
    const mind = await core.createMind({ title: "Tide notes" });

    // Two checks before the User agrees.
    await core.recordAiUse([
      { mindId: mind.id, kind: "sentence-checked", characters: 0 },
      { mindId: mind.id, kind: "sentence-checked", characters: 0 },
    ]);
    clock.advance(60 * 60 * 1000);
    await core.updatePrivacySettings({ usageData: true });

    // One check and one model call after it.
    await core.recordAiUse([{ mindId: mind.id, kind: "sentence-checked", characters: 0 }]);
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
    const { model } = await core.prepareChatModel({
      providerId: provider.id,
      modelId: "qwen3.5:4b",
    });
    await generateText({ model, prompt: "Hello", maxRetries: 0 });
    core.close();

    clock.advance(WEEK_MS);
    const again = fakeSender();
    startCore(dataDir, {
      now: clock.now,
      createChatModel: () => okModel(),
      usageData: again.sender,
    });

    expect(fieldsOf(again.sent, "model_spend_week")).toEqual([
      expect.objectContaining({ route: "local", checks: 1, questions: 0 }),
    ]);
  });

  test("a cleared AI use record leaves no checks in the week's event", async () => {
    const clock = manualClock(TUESDAY);
    const dataDir = await createTempDataFolder();
    const { sender } = fakeSender();
    const core = startCore(dataDir, {
      now: clock.now,
      createChatModel: () => okModel(),
      usageData: sender,
    });
    await core.updatePrivacySettings({ usageData: true });
    const mind = await core.createMind({ title: "Tide notes" });
    await core.recordAiUse([{ mindId: mind.id, kind: "sentence-checked", characters: 0 }]);
    await core.clearAiUse();
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
    const { model } = await core.prepareChatModel({
      providerId: provider.id,
      modelId: "qwen3.5:4b",
    });
    await generateText({ model, prompt: "Hello", maxRetries: 0 });
    core.close();

    clock.advance(WEEK_MS);
    const again = fakeSender();
    startCore(dataDir, {
      now: clock.now,
      createChatModel: () => okModel(),
      usageData: again.sender,
    });

    expect(fieldsOf(again.sent, "model_spend_week")).toEqual([
      expect.objectContaining({ route: "local", checks: 0, questions: 0 }),
    ]);
  });

  test("a week missed while the app was closed is not sent", async () => {
    const clock = manualClock(TUESDAY);
    const dataDir = await createTempDataFolder();
    const { sender } = fakeSender();
    const core = startCore(dataDir, {
      now: clock.now,
      createChatModel: () => okModel(),
      usageData: sender,
    });
    await core.updatePrivacySettings({ usageData: true });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
    const { model } = await core.prepareChatModel({
      providerId: provider.id,
      modelId: "qwen3.5:4b",
    });
    await generateText({ model, prompt: "Hello", maxRetries: 0 });
    core.close();

    // Closed for three weeks: only the last completed week is considered, and it had no call.
    clock.advance(3 * WEEK_MS);
    const again = fakeSender();
    startCore(dataDir, {
      now: clock.now,
      createChatModel: () => okModel(),
      usageData: again.sender,
    });

    expect(again.sent.map((message) => message.event)).toContain("app_opened");
    expect(fieldsOf(again.sent, "model_spend_week")).toEqual([]);
  });

  test("the spend range's edges: exactly $1, $5, $20 and $50, and just under each", () => {
    expect(spendRange(0)).toBe("0");
    expect(spendRange(0.01)).toBe("under_1");
    expect(spendRange(0.999999)).toBe("under_1");
    expect(spendRange(1)).toBe("1_5");
    expect(spendRange(4.999999)).toBe("1_5");
    expect(spendRange(5)).toBe("5_20");
    expect(spendRange(19.999999)).toBe("5_20");
    expect(spendRange(20)).toBe("20_50");
    expect(spendRange(49.999999)).toBe("20_50");
    expect(spendRange(50)).toBe("over_50");
    expect(spendRange(500)).toBe("over_50");
  });
});
