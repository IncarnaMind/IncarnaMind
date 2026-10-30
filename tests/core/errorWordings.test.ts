import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InvalidInputError, NotFoundError } from "../../src/core/errors";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";
import { startAgentsCore } from "../helpers/agents";
import { createTempDataFolder, startCore } from "../helpers/core";
import { replyingModel } from "../helpers/models";

/*
 * The core's errors in the User's language (#627). An error the window shows carries a wording, a
 * key of the dictionary with its values, beside its English sentence, which the log and a notice's
 * Details keep. Every wording reads in Chinese, and a new error with only an English sentence
 * fails here, so none arrives untranslated.
 */

const CORE = join(import.meta.dirname, "../../src/core");

/**
 * The errors still thrown with only an English sentence, by file under src/core: mostly checks of
 * what the window sends, which a User never meets. A new error gets a wording instead
 * (src/core/errors.ts); when one gets a wording, lower its file's count.
 */
const SENTENCES_LEFT: Record<string, number> = {
  "agents/index.ts": 6,
  "agents/setup.ts": 4,
  "aiUse.ts": 7,
  "answers/checks/index.ts": 6,
  "answers/index.ts": 6,
  "approvals.ts": 9,
  "checkpoints/index.ts": 3,
  "citationStyles/request.ts": 6,
  "citedPages.ts": 1,
  "comparisons/index.ts": 6,
  "connectors/config.ts": 12,
  "connectors/index.ts": 4,
  "consent.ts": 6,
  "conversations/index.ts": 10,
  "core.ts": 22,
  "documents/evidence.ts": 2,
  "documents/index.ts": 19,
  "documents/library.ts": 4,
  "documents/retention.ts": 8,
  "documents/web/index.ts": 5,
  "edits/index.ts": 10,
  "embedding/active.ts": 2,
  "exports/index.ts": 4,
  "folders.ts": 1,
  "layout.ts": 24,
  "library/index.ts": 14,
  "meetings/index.ts": 10,
  "mindContent.ts": 2,
  "mindIndex.ts": 1,
  "minds.ts": 6,
  "noteAdding.ts": 5,
  "outputFiles.ts": 6,
  "privacy.ts": 5,
  "providers/apiKey.ts": 1,
  "providers/chat.ts": 12,
  "providers/embeddings.ts": 7,
  "providers/kinds.ts": 2,
  "providers/rerank.ts": 6,
  "recentlyDeleted.ts": 3,
  "referenceRecords/import/index.ts": 2,
  "referenceRecords/index.ts": 6,
  "runs/tasks.ts": 5,
  "scope.ts": 2,
  "settings.ts": 5,
  "skills/draft.ts": 3,
  "skills/index.ts": 6,
  "sources/index.ts": 8,
  "sources/tool.ts": 2,
  "suggestions/index.ts": 6,
  "tags/index.ts": 11,
  "tags/jev.ts": 5,
  "tags/tagger.ts": 1,
  "tools/web/tools.ts": 1,
  "usageData.ts": 3,
  "wordImports.ts": 3,
};

const SENTENCE_ONLY = /new (?:InvalidInputError|NotFoundError)\(\s*(?!\{)/g;
const WORDING_KEY = /new \w+Error\(\{\s*key: "([^"]+)"/g;

const coreSources = () =>
  readdirSync(CORE, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      file: name.split("\\").join("/"),
      text: readFileSync(join(CORE, name), "utf8"),
    }));

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("an error the window shows", () => {
  test("keeps its English sentence beside its wording", () => {
    const error = new InvalidInputError({
      key: "error.document.nameTooLong",
      values: { max: 500 },
    });
    expect(error.message).toBe("A Document’s name can’t be longer than 500 characters.");
    expect(error.wording).toEqual({ key: "error.document.nameTooLong", values: { max: 500 } });
    expect(new NotFoundError("It was deleted.").wording).toBeNull();
  });

  test("says its sentence in English whatever the interface language, and its wording for the window", async () => {
    const core = startCore(await createTempDataFolder());
    await core.updateSettings({ user: { language: "zh-CN" } });
    const renaming = core.renameDocument("no-such-id", "Tides");
    await expect(renaming).rejects.toThrow(NotFoundError);
    await expect(renaming).rejects.toMatchObject({
      message: "There is no such Document.",
      wording: { key: "error.document.notFound" },
    });
  });

  test("has Chinese words for every wording, with the values the English names", () => {
    const english = new Map(Object.entries(en));
    const untranslated = Object.entries(zhCN)
      .filter(([key]) => key.startsWith("error."))
      .filter(
        ([key, chinese]) =>
          !/\p{Script=Han}/u.test(chinese) ||
          placeholders(chinese).join() !== placeholders(english.get(key) ?? "").join(),
      )
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });

  test("is worded from the error keys of the dictionary", () => {
    const strays = coreSources().flatMap(({ file, text }) =>
      [...text.matchAll(WORDING_KEY)]
        .map((m) => m[1] ?? "")
        .filter((key) => !key.startsWith("error.") || !Object.hasOwn(en, key))
        .map((key) => `${file}: ${key}`),
    );
    expect(strays).toEqual([]);
  });

  test("comes with a wording: no new error is thrown with only an English sentence", () => {
    const counted = Object.fromEntries(
      coreSources()
        .map(({ file, text }) => [file, text.match(SENTENCE_ONLY)?.length ?? 0] as const)
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(
      counted,
      "Give the new error a wording, { key, values }, with its key in src/shared/i18n/en.ts and zh-CN.ts; or, when one got a wording, lower its file's count in SENTENCES_LEFT.",
    ).toEqual(SENTENCES_LEFT);
  });
});

describe("the errors a User meets in each area", () => {
  test("Settings → Agents says a name that is empty, too long or taken, and an agent that isn't connected", async () => {
    const { core } = await startAgentsCore(replyingModel());
    await core.setAgentsEnabled(true);
    await core.connectAgent({ name: "Codex", client: "codex" });

    await expect(core.connectAgent({ name: " " })).rejects.toMatchObject({
      message: "Give the agent a name.",
      wording: { key: "error.agent.nameEmpty" },
    });
    await expect(core.connectAgent({ name: "x".repeat(81) })).rejects.toMatchObject({
      message: "An agent’s name can be at most 80 characters.",
      wording: { key: "error.agent.nameTooLong", values: { max: 80 } },
    });
    await expect(core.connectAgent({ name: "codex" })).rejects.toMatchObject({
      message: "An agent named “codex” is already connected.",
      wording: { key: "error.agent.nameTaken", values: { name: "codex" } },
    });
    await expect(core.updateAgent("no-such-agent", {})).rejects.toMatchObject({
      wording: { key: "error.agent.notConnected" },
    });
  });

  test("Organize says a classifier that can't be used, and Organize with nothing to organize by", async () => {
    const core = startCore(await createTempDataFolder());
    const save = (classifier: Parameters<typeof core.saveLibrarySettings>[0]["classifier"]) =>
      core.saveLibrarySettings({ classifier, automatic: false });

    await expect(core.classifyDocuments()).rejects.toMatchObject({
      wording: { key: "error.library.noClassifier" },
    });
    await expect(
      save({ kind: "chat", choice: { providerId: "no-such-provider", modelId: "m" } }),
    ).rejects.toMatchObject({ wording: { key: "error.library.classifierModel" } });
    await expect(save({ kind: "auto", baseUrl: "https://example.com" })).rejects.toMatchObject({
      wording: { key: "error.library.autoNotLocal" },
    });
    await expect(
      save({ kind: "ollama", baseUrl: "http://127.0.0.1:11434", modelId: " " }),
    ).rejects.toMatchObject({ wording: { key: "error.library.localModelMissing" } });
    await expect(
      save({ kind: "ollama", baseUrl: "https://example.com", modelId: "tev1:4b" }),
    ).rejects.toMatchObject({ wording: { key: "error.library.ollamaNotLocal" } });

    await save({ kind: "jev" });
    await expect(core.classifyDocuments()).rejects.toMatchObject({
      wording: { key: "error.library.noFolders" },
    });
  });

  test("A Meeting that isn't there", async () => {
    const core = startCore(await createTempDataFolder());
    await expect(core.startMeeting({ meetingId: "no-such-meeting" })).rejects.toMatchObject({
      wording: { key: "error.meeting.notFound" },
    });
  });

  test("Comparison tables say no Question, no Documents, and the limits", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Harbours" });
    const compare = (questions: string[], documentIds: string[] = []) =>
      core.compareDocuments({ mindId: mind.id, questions, documentIds });

    await expect(compare([])).rejects.toMatchObject({
      message: "Add a Question to compare by.",
      wording: { key: "error.comparison.noQuestion" },
    });
    await expect(compare(["Who?"])).rejects.toMatchObject({
      wording: { key: "error.comparison.noDocuments" },
    });
    await expect(
      compare(Array.from({ length: 13 }, (_, n) => `Question ${n}`)),
    ).rejects.toMatchObject({
      wording: { key: "error.comparison.tooManyQuestions", values: { max: 12 } },
    });
    await expect(compare(["x".repeat(501)])).rejects.toMatchObject({
      wording: { key: "error.comparison.questionTooLong", values: { max: 500 } },
    });
  });

  test("Find sources says nothing to search for, years the wrong way round, and a key that isn't one", async () => {
    const core = startCore(await createTempDataFolder());
    await expect(core.findSources({ query: "  " })).rejects.toMatchObject({
      wording: { key: "error.sources.nothingToFind" },
    });
    await expect(
      core.findSources({ query: "tides", fromYear: 2020, toYear: 2010 }),
    ).rejects.toMatchObject({ wording: { key: "error.sources.yearsOrder" } });
    await expect(core.setSourceProviderKey("openfda", "two words")).rejects.toMatchObject({
      wording: { key: "error.sources.keyLooksWrong" },
    });
  });

  test("Skills say a Skill that is gone and a preview that expired", async () => {
    const core = startCore(await createTempDataFolder());
    await expect(core.setSkillEnabled("no-such-skill", true)).rejects.toMatchObject({
      wording: { key: "error.skill.notFound" },
    });
    await expect(core.importSkill("an-old-preview")).rejects.toMatchObject({
      wording: { key: "error.skill.previewExpired" },
    });
    await expect(
      core.setApprovalPolicy({
        subject: { kind: "skill-script", skillId: "no-such-skill" },
        policy: "always",
        riskAccepted: true,
      }),
    ).rejects.toMatchObject({ wording: { key: "error.skill.notFound" } });
  });

  test("a claim too long to check, and a Checkpoint that is gone, say their wordings", async () => {
    const core = startCore(await createTempDataFolder());
    await expect(core.checkClaim({ claim: "x".repeat(2001) })).rejects.toMatchObject({
      wording: { key: "error.check.claimTooLong", values: { max: 2000 } },
    });
    const mind = await core.createMind({ title: "Harbours" });
    await expect(core.restoreCheckpoint(mind.id, "nothing")).rejects.toMatchObject({
      message: "That version is no longer kept.",
      wording: { key: "error.history.gone" },
    });
  });
});
