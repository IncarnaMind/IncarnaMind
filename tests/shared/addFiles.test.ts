import { describe, expect, test } from "vitest";
import { DOCUMENT_EXTENSIONS, UNREAD_FORMATS } from "../../src/core/documents/files";
import { ADDABLE_EXTENSIONS, ADDABLE_FILES_ACCEPT } from "../../src/shared/addFilesAction";

describe("What Add Documents offers (#762)", () => {
  test("every kind IncarnaMind reads, and every kind it names a next step for, is offered", () => {
    const offered = new Set(ADDABLE_EXTENSIONS);
    // Transcripts are a Meeting's and its files', not a kind the pickers offer.
    const read = Object.entries(DOCUMENT_EXTENSIONS)
      .filter(([kind]) => kind !== "transcript")
      .flatMap(([, extensions]) => extensions);
    for (const extension of read) expect(offered, extension).toContain(extension);
    for (const extension of UNREAD_FORMATS)
      expect(offered, extension).toContain(extension.slice(1));
  });

  test("every extension offered is one IncarnaMind reads or names a next step for", () => {
    const known = new Set([
      ...Object.values(DOCUMENT_EXTENSIONS).flat(),
      ...[...UNREAD_FORMATS].map((extension) => extension.slice(1)),
    ]);
    for (const extension of ADDABLE_EXTENSIONS) expect(known, extension).toContain(extension);
  });

  test("the file input takes them all, with their dots", () => {
    expect(ADDABLE_FILES_ACCEPT.split(",")).toEqual(
      ADDABLE_EXTENSIONS.map((extension) => `.${extension}`),
    );
    expect(ADDABLE_FILES_ACCEPT).toContain(".png");
    expect(ADDABLE_FILES_ACCEPT).toContain(".rtf");
    expect(ADDABLE_FILES_ACCEPT).toContain(".html");
    expect(ADDABLE_FILES_ACCEPT).toContain(".doc");
  });
});
