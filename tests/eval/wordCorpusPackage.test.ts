import { expect, test } from "vitest";
import {
  checkInputPackage,
  corpusFailure,
  inspectPackage,
  readExtended,
} from "../../eval/word/corpus";
import { checkExport } from "../../eval/word/exports";
import { part, unzip } from "../helpers/docx";
import { paragraph, run, wordFile } from "../helpers/word";
import { buildZip } from "../helpers/zip";

test("the pinned unsupported-fields input stays malformed and is classified as a known package problem", async () => {
  const entry = readExtended().find(
    (each) => each.name === "libreoffice/Unsupportedtextfields.docx",
  );
  if (!entry) throw new Error("The unsupported-fields input is missing from the corpus.");
  expect(entry.sha256).toBe("b3f06485fae21d09a76a5dddef09564d50bdfd4e77f9db29734065c3009fdc81");
  const bytes = wordFile({
    body: paragraph(
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> NOTEREF   \\* MERGEFORMAT </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        run("Error! No bookmark name given.") +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
    ),
  });
  const { features, problems } = await inspectPackage(bytes);
  expect(problems).toEqual(["word/document.xml: NOTEREF \\* points at no bookmark"]);
  const subject = { name: entry.name, known: entry.known };
  const outcome = await checkInputPackage(bytes, features);
  expect(outcome).toMatchObject({ ok: false, inspectionProblem: true });
  const reported = corpusFailure(subject, "package", outcome);
  expect(reported.known).toMatch(/known: NOTEREF.*bookmark/);
  expect(reported.failure).toBeUndefined();
  const stale = await checkInputPackage(bytes, {
    ...features,
    paragraphs: features.paragraphs + 1,
  });
  expect(corpusFailure(subject, "package", stale)).toEqual({
    failure: `${entry.name}: package: its listed features are out of date: paragraphs`,
  });
  expect(corpusFailure({ name: entry.name }, "package", outcome)).toEqual({
    failure: `${entry.name}: package: ${problems.join("; ")}`,
  });
});

test.each([
  "imports as a Mind",
  "opens in LibreOffice",
  "exports back",
  "export opens in LibreOffice",
  "exports for review",
  "review export opens in LibreOffice",
  "resolves someone's changes",
  "that export opens in LibreOffice",
  "exports with the Citations in a list",
  "list export opens in LibreOffice",
])("a known input defect never waives a failure in %s", (step) => {
  expect(
    corpusFailure({ name: "known.docx", known: "Malformed input package" }, step, {
      detail: "Failed",
      inspectionProblem: true,
    }),
  ).toEqual({ failure: `known.docx: ${step}: Failed` });
});

test("an exported NOTEREF passes with its bookmark and fails if its target is changed to a missing bookmark", async () => {
  const outcome = await checkExport(wordFile({ body: paragraph("The tenant pays rent.") }));
  expect(outcome.ok, outcome.detail).toBe(true);
  if (!outcome.exported) throw new Error("The round-trip check produced no export.");
  expect((await inspectPackage(outcome.exported)).problems).toEqual([]);
  const parts = unzip(outcome.exported);
  const xml = part(parts, "word/document.xml");
  const reference = /\bNOTEREF\s+(\S+)/.exec(xml)?.[1];
  if (!reference) throw new Error("The repeated Citation produced no NOTEREF field.");
  const changed = xml.replace(`NOTEREF ${reference}`, "NOTEREF MissingBookmark");
  expect(changed).not.toBe(xml);
  parts.set("word/document.xml", Buffer.from(changed));
  const broken = buildZip([...parts].map(([name, data]) => ({ name, data })));
  const { problems } = await inspectPackage(broken);
  expect(problems).toEqual(["word/document.xml: NOTEREF MissingBookmark points at no bookmark"]);
  expect(
    corpusFailure({ name: "export.docx", known: "Malformed input package" }, "exports back", {
      detail: problems.join("; "),
    }),
  ).toEqual({ failure: `export.docx: exports back: ${problems.join("; ")}` });
});

test("stale feature metadata still fails for a known input whose package is sound", async () => {
  const bytes = wordFile({ body: paragraph("The tenant pays rent.") });
  const { features, problems } = await inspectPackage(bytes);
  expect(problems).toEqual([]);
  expect(await checkInputPackage(bytes, features)).toEqual({ ok: true, detail: "" });
  const outcome = await checkInputPackage(bytes, {
    ...features,
    paragraphs: features.paragraphs + 1,
  });
  expect(outcome).toEqual({
    ok: false,
    detail: "its listed features are out of date: paragraphs",
  });
  expect(
    corpusFailure({ name: "known.docx", known: "Old package defect" }, "package", outcome),
  ).toEqual({
    failure: "known.docx: package: its listed features are out of date: paragraphs",
  });
});
