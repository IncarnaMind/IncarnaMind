import { describe, expect, test } from "vitest";
import type { Document, Mind } from "../../src/core/api";
import { saidInLine } from "../../src/renderer/src/lineNames";
import { moveMessage } from "../../src/renderer/src/moves";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * A name inside a line is cut in the middle past the limit, and the line's own words are never
 * cut (DESIGN.md, Words on screen; #400): the undo line, problems and replies say it through
 * `saidInLine`. A name within the limit is whole; the line wraps instead.
 */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

const LONG = "Quarterly review of harbour dues and the wider coastal levy schedule 2026";

describe("a name in a line", () => {
  test("a short name is said whole, with no second message", () => {
    const said = saidInLine(en, (t) => t("object.renamed", { name: "Tides" }));
    expect(said.message).toBe("Renamed to “Tides”");
    expect(said.fullMessage).toBeUndefined();
  });

  test("a long name is cut in the middle, and the whole one is kept for the tooltip", () => {
    const said = saidInLine(en, (t) => t("object.deleted", { name: LONG }));
    expect(said.message).toBe(
      "Moved “Quarterly review of … levy schedule 2026” to Recently deleted",
    );
    expect(said.fullMessage).toBe(`Moved “${LONG}” to Recently deleted`);
  });

  test("the words around the name stay whole", () => {
    const { message } = saidInLine(en, (t) => t("move.done", { name: LONG, folder: "Finance" }));
    expect(message.startsWith("Moved “")).toBe(true);
    expect(message.endsWith("” to Finance")).toBe(true);
  });

  test("a Chinese name counts two columns a character", () => {
    const name = "信贷委员会合同审阅笔记".repeat(4);
    const { message, fullMessage } = saidInLine(zh, (t) => t("object.deleted", { name }));
    expect(message).toBe("已将“信贷委员会合同审阅笔…委员会合同审阅笔记”移到回收站");
    expect(fullMessage).toBe(`已将“${name}”移到回收站`);
  });

  test("what is not a name is not cut", () => {
    const reason = "The folder is read-only, so nothing could be saved there at the moment";
    const { message, fullMessage } = saidInLine(en, (t) =>
      t("viewer.file.openFailed", { name: LONG, reason }),
    );
    expect(message).toContain(reason);
    expect(fullMessage).toContain(LONG);
    expect(message).not.toContain(LONG);
  });

  test("a name within the limit shows whole, with no second message", () => {
    const name = "Harbour dues review, volume 22";
    expect([...name]).toHaveLength(30);
    const said = saidInLine(en, (t) => t("object.renamed", { name }));
    expect(said.message).toBe(`Renamed to “${name}”`);
    expect(said.fullMessage).toBeUndefined();
  });

  test("a name past the limit is cut in the middle, keeping its start and its extension", () => {
    const name = "Quarterly review of harbour dues and the wider coastal levy.docx";
    const { message, fullMessage } = saidInLine(en, (t) => t("object.renamed", { name }));
    expect(message).toContain("…");
    expect(message).toContain([...name].slice(0, 4).join(""));
    expect(message).toMatch(/…[^…]*\.docx”/);
    expect(message).not.toContain(name);
    expect(fullMessage).toContain(name);
  });

  test("a name made part of a bigger value goes through `cut`", () => {
    const { message, fullMessage } = saidInLine(en, (t, cut) =>
      t("coverage.main", { documents: `“${cut(LONG)}” and “Report”` }),
    );
    expect(message).toContain("…");
    expect(message).toContain("“Report”");
    expect(fullMessage).toContain(LONG);
  });

  test("a move says its name and its Folder cut, and the Edit menu's name is left alone", () => {
    const mind = (title: string): Mind => ({
      id: "a",
      title,
      autoTitle: "",
      kind: "mind",
      createdAt: "",
      updatedAt: "",
      folderId: null,
    });
    const names = { minds: [mind(LONG)], documents: [] as Document[] };
    const said = saidInLine(en, (t) => moveMessage(t, { mindIds: ["a"] }, LONG, names));
    expect(said.message.startsWith("Moved “")).toBe(true);
    expect(said.message).toContain("” to Quarterly review of … levy schedule 2026");
    expect(said.fullMessage).toBe(`Moved “${LONG}” to ${LONG}`);
  });
});
