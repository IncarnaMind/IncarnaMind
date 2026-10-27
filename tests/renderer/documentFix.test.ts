import { describe, expect, test } from "vitest";
import type { Document, DocumentFailure } from "../../src/core/api";
import { canOpenFix, documentFix } from "../../src/renderer/src/documentFix";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

let next = 0;
/** A ready Document whose file is where it was, unless said otherwise. */
const doc = (changes: Partial<Document> = {}): Document =>
  ({
    id: `doc-${++next}`,
    name: `Document ${next}`,
    kind: "pdf",
    status: "ready",
    fileStatus: "available",
    size: 2048,
    failure: null,
    web: null,
    keptByApp: false,
    ...changes,
  }) as Document;

const failed = (reason: DocumentFailure["reason"], changes: Partial<Document> = {}) =>
  doc({ status: "failed", failure: { reason, message: "" }, ...changes });

describe("A Document's fix (#763)", () => {
  test("a damaged PDF says so in its PDF app's words, with both ways on", () => {
    const fix = documentFix(failed("unreadable"));
    expect(fix).toEqual({ reason: "library.fix.damaged.pdf", open: true, retry: "retry" });
    expect(en(fix?.reason as MessageKey)).toBe(
      "Damaged file: save a copy from your PDF app, then add it",
    );
    expect(zh(fix?.reason as MessageKey)).toBe("文件已损坏：用 PDF 应用另存一份，再添加副本");
    expect(en("library.fix.open")).toBe("Open in default app");
    expect(en("library.fix.retry")).toBe("Retry");
  });

  test("a scan with no text offers Read it again, an empty file says it is empty", () => {
    expect(documentFix(doc({ status: "no-text" }))).toEqual({
      reason: "library.fix.scan",
      open: true,
      retry: "readAgain",
    });
    expect(en("library.fix.readAgain")).toBe("Read it again");
    expect(documentFix(doc({ size: 0 }))).toMatchObject({ reason: "library.fix.empty" });
    expect(en("library.fix.empty")).toBe("This file is empty");
  });

  test("a form that can't be read offers Print to PDF, a crash its Retry", () => {
    expect(documentFix(failed("forms-unread"))).toEqual({
      reason: "library.fix.forms",
      open: true,
      retry: "print",
    });
    expect(en("documents.printToPdfAction")).toBe("Open to print to PDF…");
  });

  test("a too-large file keeps its Open in default app, a failed read its Retry", () => {
    expect(documentFix(failed("too-large"))).toEqual({
      reason: "library.fix.tooLarge",
      open: true,
      retry: null,
    });
    expect(documentFix(failed("processing-error"))).toMatchObject({
      reason: "library.fix.processing",
      open: false,
      retry: "retry",
    });
  });

  test("a file that is not where it was keeps its reason and loses the ways on", () => {
    expect(documentFix(failed("unreadable", { fileStatus: "missing" }))).toEqual({
      reason: "library.fix.damaged.pdf",
      open: false,
      retry: null,
    });
  });

  test("a Document that read, or whose failure is unknown, has no fix: the viewer says its own words", () => {
    expect(documentFix(doc())).toBeNull();
    expect(documentFix(failed("file-missing"))).toBeNull();
  });

  test("Open in default app is offered only where the file is the User's to open (#763)", () => {
    // A saved web page's snapshot and a Meeting's Transcript are kept by IncarnaMind; a .vtt
    // the User added is theirs, and keeps its Open.
    const web = { address: "https://x.test" } as Document["web"];
    expect(canOpenFix(failed("unreadable", { kind: "web", web, keptByApp: true }))).toBe(false);
    expect(canOpenFix(failed("unreadable", { kind: "transcript", keptByApp: true }))).toBe(false);
    expect(canOpenFix(failed("unreadable", { kind: "transcript", keptByApp: false }))).toBe(true);
    expect(canOpenFix(failed("unreadable"))).toBe(true);
    expect(canOpenFix(doc())).toBe(false);
  });
});
