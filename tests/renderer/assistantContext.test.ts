import { describe, expect, test } from "vitest";
import { readsLine, stepsScope } from "../../src/renderer/src/assistantContext";
import type { ScopeChip } from "../../src/renderer/src/scope";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * What the next Question reads and searches, which an empty conversation says
 * (#253, #258, #391, #544, #621), and what a Question searched, in its Answer's
 * steps (#391); in English and Chinese.
 */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

const chip = (name: string | null, deleted = false): ScopeChip => ({
  kind: "folder",
  id: name ?? "gone",
  name,
  deleted,
  documentKind: null,
});

describe("what the next Question reads and searches", () => {
  test("with no Mind in focus, it searches All Documents, or what the composer chose", () => {
    expect(readsLine(en, null, [])).toBe("Searches All Documents");
    expect(readsLine(zh, null, [])).toBe("搜索全部文档");
    expect(readsLine(en, null, [chip(null, true)])).toBe("Searches All Documents");
    expect(readsLine(en, null, [chip("Thesis")])).toBe("Searches “Thesis”");
    expect(readsLine(zh, null, [chip("论文")])).toBe("搜索“论文”");
    expect(readsLine(en, null, [chip("Thesis"), chip("Leeds data")])).toBe(
      "Searches “Thesis” and 1 more",
    );
    expect(readsLine(zh, null, [chip("论文"), chip("数据")])).toBe("搜索“论文”等 2 项");
  });

  test("a Mind and its Folder", () => {
    expect(readsLine(en, "Chapter 3", [chip("Thesis")])).toBe(
      "Reads “Chapter 3” · searches “Thesis”",
    );
    expect(readsLine(zh, "第三章", [chip("论文")])).toBe("正在读“第三章” · 搜索“论文”");
  });

  test("a Mind with no scope searches All Documents; deleted items are left out", () => {
    expect(readsLine(en, "Notes", [])).toBe("Reads “Notes” · searches All Documents");
    expect(readsLine(en, "Notes", [chip(null, true), chip("Old", true)])).toBe(
      "Reads “Notes” · searches All Documents",
    );
  });

  test("a scope of several items names the first and counts the rest", () => {
    const scope = [chip("Thesis"), chip("Leeds data"), chip(null, true), chip("Report.pdf")];
    expect(readsLine(en, "Notes", scope)).toBe("Reads “Notes” · searches “Thesis” and 2 more");
    expect(readsLine(zh, "笔记", scope)).toBe("正在读“笔记” · 搜索“Thesis”等 3 项");
  });
});

describe("what an Answer's steps say was searched", () => {
  const document = (name: string): ScopeChip => ({
    kind: "document",
    id: name,
    name,
    deleted: false,
    documentKind: "pdf",
  });

  // protects=the steps quote the scope's name in English and Chinese, count Documents alone as files, and add further scopes; fails_when=a scope reads otherwise in either language; no_claim=none beyond protects.
  test("a Folder by its name, Documents alone as files, All Documents, and further scopes", () => {
    expect(stepsScope(en, [chip("Thesis")])).toBe("“Thesis”");
    expect(stepsScope(zh, [chip("论文")])).toBe("“论文”");
    expect(stepsScope(en, [])).toBe("All Documents");
    expect(stepsScope(zh, [])).toBe("全部文档");
    expect(stepsScope(en, [document("Report")])).toBe("“Report”");
    expect(stepsScope(en, [document("A"), document("B"), document("C")])).toBe("3 files");
    expect(stepsScope(zh, [document("A"), document("B"), document("C")])).toBe("所选的 3 个文件");
    expect(stepsScope(en, [chip("Thesis"), document("Report")], 1)).toBe("“Thesis” +2");
    expect(stepsScope(zh, [chip("Thesis")], 1)).toBe("“Thesis”等 2 项");
    expect(stepsScope(en, [chip(null, true)])).toBe("“Deleted Folder”");
  });
});
