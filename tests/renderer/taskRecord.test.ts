import { describe, expect, test } from "vitest";
import { recordLines } from "../../src/renderer/src/taskRecord";
import { translate } from "../../src/shared/i18n";

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("zh-CN", key, params);

describe("a finished Task's journal record", () => {
  test("shows saved sources, approval outcomes and read steering in English", () => {
    expect(
      recordLines(
        {
          sources: { folderId: "f1", folder: "Research", documents: 1, tags: ["Tea"] },
          approvals: [{ key: "~approve:save", allowed: true }],
          messages: ["Keep it short"],
        },
        en,
      ),
    ).toEqual({
      sources: ["1 source saved in Research", "Tags: Tea"],
      approvals: ["save: Allowed"],
      messages: ["Keep it short"],
    });
  });

  test("shows declined and empty fields in Simplified Chinese", () => {
    expect(
      recordLines(
        {
          sources: { folderId: "", folder: "", documents: 0, tags: [], declined: true },
          approvals: [{ key: "~approve:save", allowed: false }],
          messages: [],
        },
        zh,
      ),
    ).toEqual({
      sources: ["已拒绝保存来源"],
      approvals: ["save: 已拒绝"],
      messages: ["无告诉它的消息"],
    });
    expect(recordLines({ sources: null, approvals: [], messages: [] }, zh)).toEqual({
      sources: ["未保存来源"],
      approvals: ["无批准记录"],
      messages: ["无告诉它的消息"],
    });
  });
});
