import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DATABASE_FILE,
  type Executor,
  type ExportPreferences,
  type GettingStarted,
  InvalidInputError,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";

/**
 * Export uses Word until the User saves other options, and the deliverables leave Questions
 * out. A Word file tracks the User's edits and comments on failed checks (#107); whether it
 * marks AI text is the User's to say (#1380).
 */
const DEFAULT_WORD = {
  includeQuestions: false,
  trackChanges: true,
  markAiText: null,
  commentFailedChecks: true,
} as const;

const DEFAULT_EXPORT = {
  format: "docx",
  docx: DEFAULT_WORD,
  pdf: { includeQuestions: false },
  html: { includeQuestions: false },
  "share-page": { includeQuestions: false, citationCards: true, checkedLine: false },
} as const;

const PDF_EXPORT = {
  format: "pdf",
  docx: { ...DEFAULT_WORD, markAiText: "leave" },
  pdf: { includeQuestions: true },
  html: { includeQuestions: false },
  "share-page": { includeQuestions: true, citationCards: false, checkedLine: true },
  theirChanges: "accepted",
} as const;

describe("Settings", () => {
  test("the old switch for recording meetings, on or off, is ignored", async () => {
    for (const old of [true, false]) {
      const dataDir = await createTempDataFolder();
      startCore(dataDir).close();
      const db = openDatabase(join(dataDir, DATABASE_FILE));
      const at = new Date().toISOString();
      db.run(
        "INSERT INTO device_settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [crypto.randomUUID(), "meetingsEnabled", JSON.stringify(old), at, at],
      );
      db.close();
      const core = startCore(dataDir);
      expect(Object.keys((await core.getSettings()).device)).not.toContain("meetingsEnabled");
      core.close();
    }
  });

  test("a new data folder starts with the defaults", async () => {
    const core = startCore(await createTempDataFolder());

    expect(await core.getSettings()).toEqual({
      user: {
        language: "system",
        chatModel: null,
        quickTasksModel: null,
        imageModel: null,
        suggestWhileWriting: false,
        leaveOutOwnFiles: true,
        exportOptions: DEFAULT_EXPORT,
        authorName: null,
        personId: null,
        monthlyCap: null,
        webSearch: false,
        keepWebPageLook: false,
        taskNotifications: true,
        recentCitationStyles: [],
        newMindStyle: { font: "default", size: "default" },
        meetingWords: [],
        transcriptScript: null,
      },
      device: {
        sidebarWidth: 248,
        sidebarHidden: false,
        sandboxNoticeDismissed: false,
        openedBefore: false,
        gettingStarted: {
          started: false,
          citationChecked: false,
          mistakeSeen: false,
          indexed: false,
          askedOwn: false,
          askedReady: false,
          exported: false,
          hidden: false,
          seen: false,
        },
        skillScriptsEnabled: true,
        skillScriptTimeoutSeconds: 60,
        suggestionOffers: 0,
        tips: {},
        meetingSystemAudio: true,
        transcriptionRoute: null,
        modelSource: "auto",
        meetingNoticeAccepted: false,
        meetingPanel: true,
        meetingPanelHidden: true,
        meetingHelpKeys: {},
        motion: "system",
        lastChatModel: null,
      },
      language: "en",
      scriptSandbox: "none",
      // No capture in these tests: Meetings can't record.
      meetingAudio: "none",
      author: "Priya Raman",
      chineseScript: "simplified",
    });
  });

  test("say how Skill scripts run here: at the level of the Executor the app gave the core", async () => {
    const executor: Executor = {
      level: "os",
      run: async () => {
        throw new Error("Nothing runs in this test.");
      },
    };
    const core = startCore(await createTempDataFolder(), { executor });

    expect((await core.getSettings()).scriptSandbox).toBe("os");
    // Not a setting: it can't be changed.
    await expect(
      core.updateSettings({ device: { scriptSandbox: "none" } } as never),
    ).rejects.toThrow(InvalidInputError);
  });

  test.each([
    { system: ["zh-Hans-CN", "en-US"], expected: "zh-CN" },
    { system: ["zh-TW"], expected: "zh-CN" },
    { system: ["en-GB", "zh-CN"], expected: "en" },
    { system: ["fr-FR", "zh-CN"], expected: "zh-CN" },
    { system: ["fr-FR", "de-DE"], expected: "en" },
    { system: [], expected: "en" },
  ])(
    "by default the language follows the OS: $system → $expected",
    async ({ system, expected }) => {
      const core = startCore(await createTempDataFolder(), { systemLanguages: () => system });

      expect((await core.getSettings()).language).toBe(expected);
    },
  );

  test("a chosen language overrides the OS language", async () => {
    const core = startCore(await createTempDataFolder(), { systemLanguages: () => ["en-US"] });

    const settings = await core.updateSettings({ user: { language: "zh-CN" } });

    expect(settings.user.language).toBe("zh-CN");
    expect(settings.language).toBe("zh-CN");
    expect(await core.getSettings()).toEqual(settings);
  });

  test("choosing 'system' again goes back to the OS language", async () => {
    const core = startCore(await createTempDataFolder(), { systemLanguages: () => ["zh-CN"] });
    await core.updateSettings({ user: { language: "en" } });

    const settings = await core.updateSettings({ user: { language: "system" } });

    expect(settings.language).toBe("zh-CN");
  });

  test("per-User and per-device settings change independently", async () => {
    const core = startCore(await createTempDataFolder());

    await core.updateSettings({ device: { sidebarWidth: 320 } });
    const settings = await core.updateSettings({ user: { language: "zh-CN" } });

    expect(settings.user).toEqual({
      language: "zh-CN",
      chatModel: null,
      quickTasksModel: null,
      imageModel: null,
      suggestWhileWriting: false,
      leaveOutOwnFiles: true,
      exportOptions: DEFAULT_EXPORT,
      authorName: null,
      personId: null,
      monthlyCap: null,
      webSearch: false,
      keepWebPageLook: false,
      taskNotifications: true,
      recentCitationStyles: [],
      newMindStyle: { font: "default", size: "default" },
      meetingWords: [],
      transcriptScript: null,
    });
    expect(settings.device).toEqual({
      sidebarWidth: 320,
      sidebarHidden: false,
      sandboxNoticeDismissed: false,
      openedBefore: false,
      gettingStarted: {
        started: false,
        citationChecked: false,
        mistakeSeen: false,
        indexed: false,
        askedOwn: false,
        askedReady: false,
        exported: false,
        hidden: false,
        seen: false,
      },
      skillScriptsEnabled: true,
      skillScriptTimeoutSeconds: 60,
      suggestionOffers: 0,
      tips: {},
      meetingSystemAudio: true,
      transcriptionRoute: null,
      modelSource: "auto",
      meetingNoticeAccepted: false,
      meetingPanel: true,
      meetingPanelHidden: true,
      meetingHelpKeys: {},
      motion: "system",
      lastChatModel: null,
    });
  });

  test("Task notifications are on until the User turns them off, and each answer is kept", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    expect((await before.getSettings()).user.taskNotifications).toBe(true);
    expect(
      (await before.updateSettings({ user: { taskNotifications: false } })).user.taskNotifications,
    ).toBe(false);
    before.close();

    const after = startCore(dataDir);
    expect((await after.getSettings()).user.taskNotifications).toBe(false);
    after.close();
  });

  test("export options saved before the web page to share (#72) read its defaults", async () => {
    const core = startCore(await createTempDataFolder());
    const { "share-page": _, ...before } = { ...DEFAULT_EXPORT, format: "pdf" as const };

    await core.updateSettings({
      user: { exportOptions: before as unknown as ExportPreferences },
    });

    expect((await core.getSettings()).user.exportOptions).toEqual({
      ...DEFAULT_EXPORT,
      format: "pdf",
    });
  });

  test("whether a Word file marks AI text is not answered until the User answers, and each answer is kept", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    expect((await before.getSettings()).user.exportOptions.docx.markAiText).toBeNull();

    for (const answer of ["mark", "leave"] as const) {
      const saved = await before.updateSettings({
        user: {
          exportOptions: {
            ...DEFAULT_EXPORT,
            docx: { ...DEFAULT_WORD, markAiText: answer },
          },
        },
      });
      expect(saved.user.exportOptions.docx.markAiText).toBe(answer);
    }
    before.close();

    const after = startCore(dataDir);
    expect((await after.getSettings()).user.exportOptions.docx.markAiText).toBe("leave");
    after.close();
  });

  test("where Word and PDF put the Citations is not answered until the User answers, and each answer is kept (#1600)", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    expect((await before.getSettings()).user.exportOptions.citationPlace).toBeUndefined();

    for (const answer of ["list", "footnotes"] as const) {
      const saved = await before.updateSettings({
        user: { exportOptions: { ...DEFAULT_EXPORT, citationPlace: answer } },
      });
      expect(saved.user.exportOptions.citationPlace).toBe(answer);
    }
    before.close();

    const after = startCore(dataDir);
    expect((await after.getSettings()).user.exportOptions.citationPlace).toBe("footnotes");
    after.close();
  });

  test.each([
    { saved: true, read: null, name: "on is not an answer, so the question is asked once" },
    { saved: false, read: "leave", name: "off was a choice not to mark" },
  ])(
    "the switch for marking AI text, saved before it became a question: $name (#1380)",
    async ({ saved, read }) => {
      const dataDir = await createTempDataFolder();
      startCore(dataDir).close();
      const db = openDatabase(join(dataDir, DATABASE_FILE));
      const at = new Date().toISOString();
      db.run(
        "INSERT INTO user_settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [
          crypto.randomUUID(),
          "exportOptions",
          JSON.stringify({
            ...DEFAULT_EXPORT,
            format: "pdf",
            docx: { ...DEFAULT_WORD, markAiText: saved },
          }),
          at,
          at,
        ],
      );
      db.close();

      const core = startCore(dataDir);
      expect((await core.getSettings()).user.exportOptions).toEqual({
        ...DEFAULT_EXPORT,
        format: "pdf",
        docx: { ...DEFAULT_WORD, markAiText: read },
      });
      core.close();
    },
  );

  test("Word options saved before its choices (#107) read marking AI text as not answered", async () => {
    const dataDir = await createTempDataFolder();
    startCore(dataDir).close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    const at = new Date().toISOString();
    db.run(
      "INSERT INTO user_settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [
        crypto.randomUUID(),
        "exportOptions",
        JSON.stringify({ ...DEFAULT_EXPORT, docx: { includeQuestions: true } }),
        at,
        at,
      ],
    );
    db.close();

    const core = startCore(dataDir);
    expect((await core.getSettings()).user.exportOptions.docx).toEqual({
      ...DEFAULT_WORD,
      includeQuestions: true,
    });
    core.close();
  });

  test("Get started's progress kept before the ready Question reads it as not asked (#123)", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    const kept = {
      started: true,
      citationChecked: false,
      mistakeSeen: false,
      indexed: false,
      askedOwn: true,
      hidden: false,
    };
    await before.updateSettings({
      device: { gettingStarted: kept as unknown as GettingStarted },
    });
    before.close();

    const after = startCore(dataDir);
    expect((await after.getSettings()).device.gettingStarted).toEqual({
      ...kept,
      askedReady: false,
      exported: false,
      seen: false,
    });
  });

  test("Get started's progress kept before the mistake had its own step takes it from the Citation step, and an absent flag is not a false one", async () => {
    const older = {
      started: true,
      indexed: true,
      askedOwn: true,
      askedReady: false,
      hidden: false,
    };
    for (const { citationChecked, mistakeSeen } of [
      { citationChecked: true, mistakeSeen: true },
      { citationChecked: false, mistakeSeen: false },
    ]) {
      const dataDir = await createTempDataFolder();
      const before = startCore(dataDir);
      await before.updateSettings({
        device: { gettingStarted: { ...older, citationChecked } as unknown as GettingStarted },
      });
      before.close();

      const after = startCore(dataDir);
      expect((await after.getSettings()).device.gettingStarted).toEqual({
        ...older,
        exported: false,
        citationChecked,
        mistakeSeen,
        seen: false,
      });
      after.close();
    }
  });

  test("a mistake not seen stays unseen when a Citation was checked, once the flag is saved", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const { gettingStarted } = (await core.getSettings()).device;
    await core.updateSettings({
      device: { gettingStarted: { ...gettingStarted, started: true, citationChecked: true } },
    });
    expect((await core.getSettings()).device.gettingStarted).toMatchObject({
      citationChecked: true,
      mistakeSeen: false,
    });
    core.close();
  });

  test("old device progress defaults to not exported; a successful export milestone survives restart", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    const { exported: _exported, ...oldProgress } = (await before.getSettings()).device
      .gettingStarted;
    await before.updateSettings({ device: { gettingStarted: oldProgress as GettingStarted } });
    before.close();
    const after = startCore(dataDir);
    const progress = (await after.getSettings()).device.gettingStarted;
    expect(progress.exported).toBe(false);
    await expect(
      after.updateSettings({
        device: { gettingStarted: { ...progress, exported: "yes" } },
      } as unknown as Parameters<typeof after.updateSettings>[0]),
    ).rejects.toThrow(InvalidInputError);
    await after.updateSettings({ device: { gettingStarted: { ...progress, exported: true } } });
    after.close();
    const reopened = startCore(dataDir);
    expect((await reopened.getSettings()).device.gettingStarted.exported).toBe(true);
    reopened.close();
  });

  test("a width must be a number", async () => {
    const core = startCore(await createTempDataFolder());

    await expect(
      core.updateSettings({ device: { sidebarWidth: null as unknown as number } }),
    ).rejects.toThrow(InvalidInputError);
  });

  test("settings survive a restart", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    const device = {
      sidebarWidth: 300,
      sidebarHidden: true,
      sandboxNoticeDismissed: true,
      openedBefore: true,
      gettingStarted: {
        started: true,
        citationChecked: true,
        mistakeSeen: true,
        indexed: false,
        askedOwn: false,
        askedReady: true,
        exported: true,
        hidden: true,
        seen: false,
      },
      skillScriptsEnabled: false,
      skillScriptTimeoutSeconds: 15,
      suggestionOffers: 1,
      tips: { "add-answer": 2 },
      meetingSystemAudio: false,
      transcriptionRoute: "local" as const,
      modelSource: "modelscope" as const,
      meetingNoticeAccepted: true,
      meetingPanel: false,
      meetingPanelHidden: false,
      meetingHelpKeys: { say: "Ctrl+Alt+Q" },
      motion: "reduced" as const,
      lastChatModel: null,
    };
    await before.updateSettings({
      user: {
        language: "zh-CN",
        suggestWhileWriting: true,
        leaveOutOwnFiles: false,
        exportOptions: PDF_EXPORT,
        authorName: "P. Raman",
        personId: "person-1",
        monthlyCap: { amount: 20, currency: "USD" },
        webSearch: true,
        keepWebPageLook: true,
        newMindStyle: { font: { family: "Georgia" }, size: "large" },
        meetingWords: ["Priya Raman", "星河科技"],
        transcriptScript: "traditional",
      },
      device,
    });
    before.close();

    const after = startCore(dataDir);

    expect(await after.getSettings()).toEqual({
      user: {
        language: "zh-CN",
        chatModel: null,
        quickTasksModel: null,
        imageModel: null,
        suggestWhileWriting: true,
        leaveOutOwnFiles: false,
        exportOptions: PDF_EXPORT,
        authorName: "P. Raman",
        personId: "person-1",
        monthlyCap: { amount: 20, currency: "USD" },
        webSearch: true,
        keepWebPageLook: true,
        taskNotifications: true,
        recentCitationStyles: [],
        newMindStyle: { font: { family: "Georgia" }, size: "large" },
        meetingWords: ["Priya Raman", "星河科技"],
        transcriptScript: "traditional",
      },
      device,
      language: "zh-CN",
      scriptSandbox: "none",
      meetingAudio: "none",
      author: "P. Raman",
      chineseScript: "traditional",
    });
  });

  test.each([
    { name: "an unknown language", patch: { user: { language: "fr" } } },
    { name: "an unknown setting", patch: { user: { theme: "dark" } } },
    { name: "a setting in the wrong group", patch: { device: { language: "en" } } },
    { name: "an unknown group", patch: { secrets: { apiKey: "sk-…" } } },
    { name: "a negative width", patch: { device: { sidebarWidth: -1 } } },
    { name: "a width that isn't a number", patch: { device: { sidebarWidth: "wide" } } },
    {
      name: "a new Mind style with a font that isn't a preset or a family",
      patch: { user: { newMindStyle: { font: "comic", size: "default" } } },
    },
    {
      name: "a new Mind style with a size it hasn't got",
      patch: { user: { newMindStyle: { font: "serif", size: "huge" } } },
    },
    { name: "the tabs the app kept before groups", patch: { device: { openMinds: ["mind-a"] } } },
    {
      name: "a checklist with a step missing",
      patch: { device: { gettingStarted: { started: true, hidden: false } } },
    },
    {
      name: "a script switch that isn't true or false",
      patch: { device: { skillScriptsEnabled: 1 } },
    },
    { name: "a script timeout of 0", patch: { device: { skillScriptTimeoutSeconds: 0 } } },
    {
      name: "a script timeout over an hour",
      patch: { device: { skillScriptTimeoutSeconds: 3601 } },
    },
    {
      name: "a script timeout in part seconds",
      patch: { device: { skillScriptTimeoutSeconds: 1.5 } },
    },
    { name: "an unknown motion choice", patch: { device: { motion: "slow" } } },
    { name: "Words to know that aren't a list", patch: { user: { meetingWords: "Priya" } } },
    { name: "a blank word to know", patch: { user: { meetingWords: ["Priya", " "] } } },
    { name: "a word to know twice", patch: { user: { meetingWords: ["Lumen", "lumen"] } } },
    {
      name: "a word to know longer than a name",
      patch: { user: { meetingWords: ["x".repeat(61)] } },
    },
    { name: "a script that isn't one", patch: { user: { transcriptScript: "pinyin" } } },
    {
      name: "Task notifications that aren't on or off",
      patch: { user: { taskNotifications: "sometimes" } },
    },
    { name: "a tip shown a negative number of times", patch: { device: { tips: { a: -1 } } } },
    { name: "a tip count that isn't a number", patch: { device: { tips: { a: "twice" } } } },
    {
      name: "an export format the app can't write",
      patch: { user: { exportOptions: { ...DEFAULT_EXPORT, format: "odt" } } },
    },
    {
      name: "export options with a format's options missing",
      patch: { user: { exportOptions: { format: "pdf", docx: { includeQuestions: false } } } },
    },
    {
      name: "an answer about marking AI text that isn't one",
      patch: {
        user: {
          exportOptions: { ...DEFAULT_EXPORT, docx: { ...DEFAULT_WORD, markAiText: "maybe" } },
        },
      },
    },
    {
      name: "export options whose Questions switch isn't true or false",
      patch: { user: { exportOptions: { ...DEFAULT_EXPORT, pdf: { includeQuestions: "yes" } } } },
    },
    {
      name: "a shared page's choice that isn't true or false",
      patch: {
        user: {
          exportOptions: {
            ...DEFAULT_EXPORT,
            "share-page": { includeQuestions: false, citationCards: "yes", checkedLine: false },
          },
        },
      },
    },
    {
      name: "a place for Citations that isn't one",
      patch: { user: { exportOptions: { ...DEFAULT_EXPORT, citationPlace: "margin" } } },
    },
    {
      name: "a way to show someone's changes that isn't one",
      patch: { user: { exportOptions: { ...DEFAULT_EXPORT, theirChanges: "hidden" } } },
    },
    {
      name: "a place to transcribe meetings that isn't one",
      patch: { device: { transcriptionRoute: "carrier-pigeon" } },
    },
    {
      name: "a default model without a model",
      patch: { user: { chatModel: { providerId: "x" } } },
    },
    {
      name: "a last chosen model without a model",
      patch: { device: { lastChatModel: { providerId: "x" } } },
    },
    {
      name: "a default model on a provider that doesn't exist",
      patch: { user: { chatModel: { providerId: "no-such-provider", modelId: "gpt-5.4-mini" } } },
    },
  ])("rejects $name and changes nothing", async ({ patch }) => {
    const core = startCore(await createTempDataFolder());
    const before = await core.getSettings();

    await expect(
      core.updateSettings({ device: { sidebarWidth: 999 }, ...(patch as object) }),
    ).rejects.toThrow(InvalidInputError);
    expect(await core.getSettings()).toEqual(before);
  });
});
