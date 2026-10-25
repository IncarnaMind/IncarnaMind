/**
 * A Library of about 100 Documents for the Library page's specs: every
 * format, English and Chinese names, seven Folders with descriptions, a
 * long name, one scan with no text, and Tags on most rows, as a User with a
 * year of work would have.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { CoreBridge, DocumentKind } from "../src/core/api";
import { docxOf, xlsxOf } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import { para, pptxOf, sp, txBody } from "../tests/helpers/pptx";
import { dismissChatSetup } from "./app";

type Format = "pdf" | "docx" | "xlsx" | "pptx" | "csv" | "md" | "txt";

/** A Document: its name (the file's, without the extension), its format and its Tags. */
type Entry = readonly [name: string, format: Format, tags?: readonly string[]];

export interface FixtureFolder {
  name: string;
  description: string;
  documents: readonly Entry[];
}

export const LONG_NAME =
  "Harbour sediment survey, east basin transects 1–14, combined field notes, lab results and the committee's comments on the revised method, final version for the board";

export const SCAN_NAME = "scan_0007";

export const FOLDERS: readonly FixtureFolder[] = [
  {
    name: "Board",
    description: "Minutes, board packs and resolutions",
    documents: [
      ["Board pack, October", "pptx", ["Slides", "Report"]],
      ["CEO report to the Board, Q3", "docx", ["Report"]],
      ["Board pack, July", "pptx", ["Slides"]],
      ["Resolution: share buyback", "docx"],
      ["Board minutes 2026-03", "pdf", ["Notes"]],
      ["Board minutes 2026-02", "pdf", ["Notes"]],
      ["Board minutes 2026-01", "pdf", ["Notes"]],
      ["Audit committee terms", "md"],
      ["Risk register", "xlsx", ["Report"]],
    ],
  },
  {
    name: "Finance",
    description: "Invoices, budgets and statements",
    documents: [
      ["Invoice 4471", "pdf", ["Invoice"]],
      ["Invoice 4502", "pdf", ["Invoice"]],
      ["Invoice 4519", "pdf", ["Invoice"]],
      ["Q2 cash flow", "xlsx", ["Notes", "Invoice"]],
      ["Q3 forecast", "xlsx", ["Report"]],
      ["Payroll summary, September", "csv", ["Report"]],
      ["Audit fee quote, Halden & Co", "pdf", ["Invoice"]],
      ["Insurance renewal 2027", "pdf", ["Contract"]],
      ["Budget 2027 draft", "xlsx", ["Report", "Notes"]],
      ["Bank statement, August", "pdf"],
      ["Expense policy", "md", ["Notes"]],
      ["VAT return Q2", "csv"],
      ["Grant spending, 2026", "xlsx", ["Report"]],
      ["Fieldwork budget 2026", "csv"],
      ["Travel claims, Q3", "txt"],
      ["Supplier payments", "csv", ["Invoice"]],
      ["Annual accounts 2025", "docx", ["Report", "Book", "Notes", "Slides"]],
    ],
  },
  {
    name: "Contracts",
    description: "Agreements we have signed or are negotiating",
    documents: [
      ["Mutual NDA, Alder Systems", "docx", ["Contract"]],
      ["NDA: Polar Freight", "pdf", ["Contract"]],
      ["Lease: Rotterdam warehouse", "pdf", ["Contract"]],
      ["Supply agreement, Northwind", "docx", ["Contract"]],
      ["Licence agreement, Coldline software", "docx", ["Contract"]],
    ],
  },
  {
    name: "Thesis: urban heat",
    description: "Papers, field data and drafts for the thesis",
    documents: [
      ["Hale: comments on chapter 2", "docx", ["Notes"]],
      ["Taha 1997: urban climates review", "pdf", ["Paper"]],
      ["Supervisor meeting notes, 3 Oct", "md", ["Notes"]],
      ["Chapter 2 draft", "docx"],
      ["Thesis outline v3", "md", ["Notes"]],
      ["Urban Heat in Six Districts", "pdf", ["Report"]],
      ["Heat and health, WHO brief", "pdf", ["Report"]],
      ["Gunawardena 2017: blue and green space", "pdf", ["Paper"]],
      ["Chen 2019: green roofs and night cooling", "pdf", ["Paper"]],
      ["Bowler et al. 2010: urban greening", "pdf", ["Paper"]],
      ["Chow et al. 2011: park cool island", "pdf", ["Paper"]],
      ["Spronken-Smith & Oke 1998", "pdf", ["Paper"]],
      ["Leeds sensor readings, June", "csv"],
      ["Leeds sensor readings, July", "csv"],
      ["Leeds sensor readings, August", "csv"],
      ["Site log, July", "md", ["Notes"]],
      ["Methods: sensor placement", "md", ["Notes"]],
      ["Sensor calibration notes", "md", ["Notes"]],
      ["Lit review: urban heat islands", "docx", ["Paper"]],
      ["Ethics approval letter", "pdf"],
      ["Conference poster, ICUC", "pptx", ["Slides"]],
    ],
  },
  {
    name: "Vendor selection 2026",
    description: "The cold-chain carrier RFP",
    documents: [
      ["Polar Freight: rate card", "xlsx", ["Report"]],
      ["Carrier calls, October", "md", ["Notes"]],
      ["Northwind rate card 2026", "xlsx"],
      ["Coldline: site visit notes", "docx", ["Notes"]],
      ["RFP: cold-chain carriers", "docx", ["Report"]],
      ["Scoring matrix", "xlsx"],
      ["Reference call, Alder Systems", "txt", ["Notes"]],
      ["Shortlist presentation", "pptx", ["Slides"]],
      ["Insurance certificates", "pdf"],
      ["Route map, Benelux", "pdf"],
    ],
  },
  {
    name: "财务报表",
    description: "季度报表、预算与发票",
    documents: [
      ["2026年第二季度财务报表", "xlsx", ["Report"]],
      ["2026年第一季度财务报表", "xlsx", ["Report"]],
      ["年度预算草案", "docx", ["Notes"]],
      ["发票 4471", "pdf", ["Invoice"]],
      ["差旅报销汇总", "csv"],
      ["审计意见书", "docx", ["Report"]],
      ["现金流量表", "xlsx"],
      ["供应商付款明细", "csv", ["Invoice"]],
    ],
  },
  {
    name: "会议纪要",
    description: "每周例会与项目会议的记录",
    documents: [
      ["会议纪要 0402", "md", ["Notes"]],
      ["会议纪要 0409", "md", ["Notes"]],
      ["会议纪要 0416", "md", ["Notes"]],
      ["项目启动会", "docx", ["Notes"]],
      ["季度复盘", "pptx", ["Slides"]],
      ["客户访谈记录", "txt", ["Notes"]],
    ],
  },
];

export const NOT_IN_A_FOLDER: readonly Entry[] = [
  ["Reading list", "md"],
  [SCAN_NAME, "pdf"],
  ["Call notes: procurement", "txt", ["Notes"]],
  ["Team offsite agenda", "docx"],
  ["Launch sync 2026-04-02", "md", ["Notes"]],
  ["Stand-up notes, 29 Sep", "md", ["Notes"]],
  ["Stand-up notes, 22 Sep", "md", ["Notes"]],
  ["Market sizing, cold chain", "xlsx", ["Report"]],
  ["Press clippings", "pdf"],
  ["Onboarding checklist", "md"],
  ["Office floor plan", "pdf"],
  ["Holiday rota", "csv"],
  ["Interview: harbour master", "txt"],
  ["Pitch deck draft", "pptx", ["Slides"]],
  ["Customer survey results", "csv", ["Report"]],
  ["城市热岛文献综述", "docx", ["Paper"]],
  ["供应商评估", "xlsx"],
  ["合同模板", "docx", ["Contract"]],
  ["读书笔记", "md", ["Notes"]],
  ["Expense receipts, March", "pdf", ["Invoice"]],
  ["Brand guidelines", "pdf"],
  [LONG_NAME, "md"],
];

export const FIXTURE_COUNT =
  FOLDERS.reduce((sum, folder) => sum + folder.documents.length, 0) + NOT_IN_A_FOLDER.length;

export const FORMAT_KINDS: Record<Format, DocumentKind> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  csv: "csv",
  md: "markdown",
  txt: "text",
};

const hasChinese = (text: string) => /\p{Script=Han}/u.test(text);

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The file's lines: its name, then a line a search for words inside can find. */
function linesOf(name: string): string[] {
  return hasChinese(name)
    ? [name, `${name}：本季度的数据已核对，详见附表。`]
    : [name, `Notes on ${name}: figures checked against the ledger on 12 March 2026.`];
}

function contentOf(name: string, format: Format): Buffer | Uint8Array | string {
  const lines = linesOf(name);
  switch (format) {
    case "pdf":
      if (name === SCAN_NAME) return buildPdf([{ image: true }]);
      return buildPdf([hasChinese(name) ? { chineseLines: lines } : { lines }]);
    case "docx":
      return docxOf([{ text: name, heading: 1 }, { text: lines[1] ?? "" }]);
    case "xlsx":
      return xlsxOf([
        {
          name: "Sheet1",
          rows: [
            ["Item", "Amount"],
            [lines[1] ?? name, 1200],
            ["Total", 1200],
          ],
        },
      ]);
    case "pptx":
      return pptxOf({
        slides: [
          {
            shapes: sp({
              txBox: true,
              body: txBody(lines.map((line) => para(escapeXml(line))).join("")),
            }),
          },
        ],
      });
    case "csv":
      return `Item,Amount\n"${(lines[1] ?? name).replace(/"/g, '""')}",1200\n`;
    case "md":
      return `# ${name}\n\n${lines[1]}\n`;
    case "txt":
      return `${lines.join("\n")}\n`;
  }
}

/** Writes every Document's file into `dir`; returns their paths, in the order above. */
export async function writeLibraryFiles(dir: string): Promise<string[]> {
  const entries = [...FOLDERS.flatMap((folder) => folder.documents), ...NOT_IN_A_FOLDER];
  const paths: string[] = [];
  for (const [name, format] of entries) {
    const path = join(dir, `${name}.${format}`);
    await writeFile(path, contentOf(name, format));
    paths.push(path);
  }
  return paths;
}

const bridge = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

/**
 * Adds the Library's files through the sidebar's file picker, waits until
 * each is read (the scan finds no text), then files them into their Folders
 * and tags them, through the core, as a User would have over time.
 */
export async function addLibrary(window: Page, dir: string): Promise<void> {
  const paths = await writeLibraryFiles(dir);
  await window.getByTestId("add-documents-input").setInputFiles(paths);
  const core = await bridge(window);
  await expect
    .poll(
      () =>
        core.evaluate(
          async (api) =>
            (await api.listDocuments()).filter(
              (each) => each.status === "ready" || each.status === "no-text",
            ).length,
        ),
      { timeout: 120_000 },
    )
    .toBe(paths.length);
  await core.evaluate(
    async (api, { folders, loose }) => {
      const documents = await api.listDocuments();
      const idOf = new Map(documents.map((each) => [each.name, each.id]));
      const tags = new Map((await api.listTags()).map((tag) => [tag.name, tag.id]));
      const tagIdOf = async (name: string) => {
        const known = tags.get(name);
        if (known) return known;
        const made = await api.createTag({ name, description: "" });
        tags.set(name, made.id);
        return made.id;
      };
      const tagging = new Map<string, string[]>();
      const tagAll = (entries: readonly (readonly [string, string, (readonly string[])?])[]) => {
        for (const [name, , names] of entries) {
          for (const tag of names ?? []) {
            const id = idOf.get(name);
            if (id) tagging.set(tag, [...(tagging.get(tag) ?? []), id]);
          }
        }
      };
      for (const folder of folders) {
        const group = await api.createLibraryGroup({
          name: folder.name,
          description: folder.description,
        });
        const documentIds = folder.documents.flatMap(([name]) => idOf.get(name) ?? []);
        await api.moveToFolder({ documentIds, folderId: group.id });
        tagAll(folder.documents);
      }
      tagAll(loose);
      for (const [tag, ids] of tagging) await api.addTagToDocuments(ids, await tagIdOf(tag));
    },
    { folders: FOLDERS, loose: NOT_IN_A_FOLDER },
  );
}

export const DELETED = ["Holiday rota", "Office floor plan"];

/** Opens a Library of about 100 Documents, two of them deleted since. */
export async function openFullLibrary(window: Page, sources: string): Promise<Locator> {
  await dismissChatSetup(window);
  await addLibrary(window, sources);
  await window.evaluate(async (names) => {
    const api = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const documents = await api.listDocuments();
    for (const name of names) {
      const doc = documents.find((each) => each.name === name);
      if (doc) await api.deleteDocument(doc.id);
    }
  }, DELETED);
  await window.getByTestId("open-library").click();
  const library = window.getByTestId("library");
  await expect(library.getByTestId("library-count")).toHaveText(
    String(FIXTURE_COUNT - DELETED.length),
  );
  return library;
}
