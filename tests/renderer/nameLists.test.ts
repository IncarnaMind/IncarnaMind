import { describe, expect, test } from "vitest";
import type { Checkpoint, ClaimReadDocument } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { readsLine } from "../../src/renderer/src/components/agents/agentWords";
import {
  envKeptLine,
  importEnvLine,
  importHeadersLine,
  keyMaskLine,
} from "../../src/renderer/src/components/connectors/connectorLines";
import { readDocumentsText } from "../../src/renderer/src/editor/readDocumentsText";
import {
  alreadyAddedLine,
  savedOutsideLine,
  skippedNamesLine,
} from "../../src/renderer/src/fileNoticeLines";
import { comparedLabel } from "../../src/renderer/src/historyLabels";
import { removedBuiltInsLine } from "../../src/renderer/src/skillText";
import { hiddenTagsLine, tagMarksLine } from "../../src/renderer/src/tagEditing";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * Lists of names the interface reads (#3048): English joins them with ", ", Chinese with 、
 * (docs/agents/zh-CN.md), each in the line the User reads.
 */

const sayIn =
  (language: Language) =>
  (key: MessageKey, params?: MessageParams): string =>
    translate(language, key, params);
const en = sayIn("en");
const zh = sayIn("zh-CN");

const chip = (name: string) => ({ tag: { name } });

describe("The Tags a Document's row names", () => {
  const chips = [chip("Q3"), chip("合同"), chip("Board")];

  test("its row lists them", () => {
    expect(tagMarksLine(en, "en", chips)).toBe("Tags: Q3, 合同, Board");
    expect(tagMarksLine(zh, "zh-CN", chips)).toBe("标签：Q3、合同、Board");
  });

  test("one Tag has nothing to join", () => {
    expect(tagMarksLine(en, "en", [chip("Q3")])).toBe("Tags: Q3");
    expect(tagMarksLine(zh, "zh-CN", [chip("Q3")])).toBe("标签：Q3");
  });

  test('the "+N" names the Tags it hides', () => {
    const hidden = chips.slice(1);
    expect(hiddenTagsLine(en, "en", hidden)).toBe("2 more: 合同, Board");
    expect(hiddenTagsLine(zh, "zh-CN", hidden)).toBe("另有 2 个：合同、Board");
  });
});

describe("The sidebar's status for an add", () => {
  test("names the files it skipped", () => {
    const files = [{ name: "租约.pages" }, { name: "Deck.key" }];
    expect(skippedNamesLine(files, "en")).toBe("租约.pages, Deck.key");
    expect(skippedNamesLine(files, "zh-CN")).toBe("租约.pages、Deck.key");
  });

  test("names the files that were Documents already", () => {
    const names = ["租约.pdf", "Notes.docx"];
    expect(alreadyAddedLine(en, "en", names)).toBe(
      "Already in IncarnaMind, so nothing new was added: 租约.pdf, Notes.docx",
    );
    expect(alreadyAddedLine(zh, "zh-CN", names)).toBe(
      "这些文件已在 IncarnaMind 中，未重复添加：租约.pdf、Notes.docx",
    );
  });

  test("names the pages saved outside the Folder, each with the Folder it went to", () => {
    const saved = [
      { name: "Tides", folder: "Contracts" },
      { name: "潮汐", folder: "" },
    ];
    expect(savedOutsideLine(en, "en", saved)).toBe(
      "These pages were saved, but not into the Folder you chose: Tides (Contracts), 潮汐",
    );
    expect(savedOutsideLine(zh, "zh-CN", saved)).toBe(
      "这些网页已保存，但没有存入你选择的文件夹：Tides (Contracts)、潮汐",
    );
  });
});

describe("The built-in Skills the User removed", () => {
  const names = ["chronology", "earnings-review"];

  test("the button that restores them lists their titles", () => {
    expect(removedBuiltInsLine(names, en, "en")).toBe("Removed: Chronology, Earnings review");
    expect(removedBuiltInsLine(names, zh, "zh-CN")).toBe("已移除：事件时间线、业绩回顾");
  });
});

describe("The Folders an agent reads", () => {
  test("its row lists them", () => {
    const names = ["Contracts", "董事会", "Not in a Folder"];
    expect(readsLine(names, en, "en")).toBe("Reads Contracts, 董事会, Not in a Folder");
    expect(readsLine(names, zh, "zh-CN")).toBe("可读取：Contracts、董事会、Not in a Folder");
  });

  test("an agent with none says so", () => {
    expect(readsLine([], en, "en")).toBe("Reads no Folders yet");
    expect(readsLine([], zh, "zh-CN")).toBe("还没有可读取的文件夹");
  });
});

describe("The names a Connector's lines list", () => {
  test("the variables its form keeps", () => {
    expect(envKeptLine(["API_KEY", "REGION"], en, "en")).toBe(
      "Leave empty to keep the saved values of API_KEY, REGION.",
    );
    expect(envKeptLine(["API_KEY", "REGION"], zh, "zh-CN")).toBe(
      "留空则保留已保存的 API_KEY、REGION 的值。",
    );
  });

  test("the variables an import brings", () => {
    expect(importEnvLine(["API_KEY", "REGION"], en, "en")).toBe(
      "Environment: API_KEY, REGION (kept in your keychain)",
    );
    expect(importEnvLine(["API_KEY", "REGION"], zh, "zh-CN")).toBe(
      "环境变量：API_KEY、REGION（加密保存在系统中）",
    );
  });

  test("the headers an import brings", () => {
    const headers = ["Authorization", "X-Api-Key"];
    expect(importHeadersLine(headers, en, "en")).toBe(
      "Stored here; sent only to this server: Authorization, X-Api-Key",
    );
    expect(importHeadersLine(headers, zh, "zh-CN")).toBe(
      "仅保存在这台设备上，只发送给对应服务器：Authorization、X-Api-Key",
    );
  });

  test("the headers that hold a signed-in key, and the key masked", () => {
    expect(keyMaskLine(["Authorization", "X-Api-Key"], "en")).toBe(
      "Authorization, X-Api-Key · ••••••••",
    );
    expect(keyMaskLine(["Authorization", "X-Api-Key"], "zh-CN")).toBe(
      "Authorization、X-Api-Key · ••••••••",
    );
  });
});

describe("History's comparison of two versions", () => {
  const now = new Date(2026, 9, 9, 17, 0);
  const accepted: Pick<Checkpoint, "createdAt" | "reason" | "name" | "file"> = {
    createdAt: new Date(2026, 9, 9, 10, 42).toISOString(),
    reason: "accept",
    name: null,
    file: null,
  };

  test("names the left version with why it was saved, and the right one", () => {
    expect(comparedLabel({ left: accepted, right: null }, now, "en", en)).toMatch(
      /^Friday 9 Oct, 10:42( am)?, before AI edits on the left, Now on the right$/,
    );
    expect(comparedLabel({ left: accepted, right: null }, now, "zh-CN", zh)).toMatch(
      /^左侧为10月9日星期五 (上午)?10:42、接受修订前，右侧为当前版本$/,
    );
  });

  test("a version saved at a pause has no reason to join", () => {
    const idle = { ...accepted, reason: "idle" as const };
    expect(comparedLabel({ left: idle, right: null }, now, "en", en)).toMatch(
      /^Friday 9 Oct, 10:42( am)? on the left, Now on the right$/,
    );
    expect(comparedLabel({ left: idle, right: null }, now, "zh-CN", zh)).toMatch(
      /^左侧为10月9日星期五 (上午)?10:42，右侧为当前版本$/,
    );
  });
});

describe("The places a check's card lists for a Document it read whole", () => {
  const read = (documentName: string, pages: number[]): ClaimReadDocument => ({
    documentId: documentName,
    documentName,
    contentHash: "hash",
    locations: pages.map((page) => ({ kind: "page" as const, from: page, to: page })),
  });

  test("lists the places of each Document, and the Documents apart", () => {
    const documents = [read("租约.pdf", [3, 5]), read("Notes.docx", [])];
    expect(readDocumentsText(documents, null, en, "en")).toBe("租约.pdf (p. 3, p. 5); Notes.docx");
    expect(readDocumentsText(documents, null, zh, "zh-CN")).toBe(
      "租约.pdf (第 3 页、第 5 页)；Notes.docx",
    );
  });

  test("a Document with one place has nothing to join", () => {
    expect(readDocumentsText([read("Lease.pdf", [3])], null, zh, "zh-CN")).toBe(
      "Lease.pdf (第 3 页)",
    );
  });
});
