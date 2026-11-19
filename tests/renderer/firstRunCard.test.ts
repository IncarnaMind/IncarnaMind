import { beforeAll, describe, expect, test } from "vitest";
import { WORK_KINDS } from "../../src/core/api";
import { commands } from "../../src/renderer/src/commands/registry";
import {
  cardStepsOf,
  FEATURE_COMMANDS,
  type NextFeature,
  nextFeatures,
  nextLeadOf,
  stepWords,
} from "../../src/renderer/src/components/firstRun/cardWords";
import { translate } from "../../src/shared/i18n";

/*
 * Get started after the first run's setup (#3296): its steps in the first pick's words, and what
 * it offers next, merged across the picks, each a command the app has.
 */

beforeAll(async () => {
  // The commands reach the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
});

describe("Get started in the User's work", () => {
  test("meetings record a meeting and get its notes; every other work adds files and asks", () => {
    expect(cardStepsOf("meetings")).toEqual(["record", "notes", "citation"]);
    for (const work of [undefined, ...WORK_KINDS.filter((kind) => kind !== "meetings")]) {
      expect(cardStepsOf(work), String(work)).toEqual(["files", "question", "citation"]);
    }
  });

  test("each step reads in the work picked first, and no pick or Something else keeps the standard words", () => {
    const titles = (work: (typeof WORK_KINDS)[number] | undefined) =>
      cardStepsOf(work).map((step) => translate("en", stepWords(work, step).title));
    expect(titles("finance")).toEqual([
      "Add your files",
      "Ask about a figure",
      "Check a figure against its source",
    ]);
    expect(titles("meetings")).toEqual([
      "Record a meeting",
      "Get the notes",
      "Check a line against what was said",
    ]);
    expect(titles(undefined)).toEqual(titles("other"));
    expect(titles(undefined)).toEqual(["Add your Documents", "Ask", "Check a Citation"]);
    expect(translate("en", stepWords("meetings", "record").done)).toBe("Recorded a meeting");
    expect(translate("zh-CN", stepWords("meetings", "notes").done)).toBe("已获得会议纪要");
  });
});

describe("Get started for a User whose own AI is connected (#3362)", () => {
  test("in every work: add Documents, ask that AI for a document, see what needs a look", () => {
    for (const work of [undefined, ...WORK_KINDS]) {
      expect(cardStepsOf(work, true), String(work)).toEqual(["files", "agentAsk", "agentLook"]);
    }
    const titles = (language: "en" | "zh-CN") =>
      cardStepsOf(undefined, true).map((step) =>
        translate(language, stepWords(undefined, step).title),
      );
    expect(titles("en")).toEqual([
      "Add your Documents",
      "Ask your AI for a document",
      "See what needs a look",
    ]);
    expect(titles("zh-CN")).toEqual(["添加你的文档", "让你的 AI 写一份文档", "查看需要留意的地方"]);
    expect(translate("en", stepWords("finance", "agentAsk").done)).toBe("Your AI wrote a note");
    expect(translate("en", stepWords("finance", "files").title)).toBe("Add your files");
  });
});

describe("what Get started offers next", () => {
  test("three at most, each pick's first before any pick's second", () => {
    expect(nextFeatures(["legal", "research"])).toEqual(["compare", "citationStyle", "exportWord"]);
    expect(nextFeatures(["finance"])).toEqual(["checkFile", "compare", "exportWord"]);
    expect(nextFeatures([])).toEqual(nextFeatures(["other"]));
    expect(nextFeatures(["finance", "reports", "legal"])).toHaveLength(3);
  });

  test("names one work, or the User for several picks or Something else", () => {
    expect(translate("en", nextLeadOf(["research"]))).toBe("Next for research and study:");
    expect(translate("en", nextLeadOf(["research", "legal"]))).toBe("Next for you:");
    expect(translate("en", nextLeadOf(["other"]))).toBe("Next for you:");
  });

  test("every feature is a command the app has", () => {
    for (const feature of Object.keys(FEATURE_COMMANDS) as NextFeature[]) {
      for (const id of FEATURE_COMMANDS[feature]) {
        expect(commands.get(id), `${feature}: ${id}`).toBeDefined();
      }
    }
  });
});
