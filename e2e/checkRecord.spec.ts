import { createHash } from "node:crypto";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { parseCsv } from "../tests/helpers/csv";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  interceptOpenPath,
  launchApp,
  nameMind,
  newMind,
  pathsOpened,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/*
 * Export check record (#738): from a Mind's ⋯ menu and from ⌘K, a record of what was checked in
 * it, as a CSV for the User's records and a PDF to file with the work, saved in the Output
 * location. The scripted model (src/main/fakeChat/checks.ts) finds a sentence supported when it
 * shares three words with a line of a Document, and otherwise unsupported. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also keep the files.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);
const SENTENCES = [
  "Spring tides happen at new and full moon.",
  "Penguins nest on the harbour cliffs.",
];

const TEXTS = {
  en: {
    entry: "Export check record…",
    found: (name: string, folder: string) => `Saved “${name}” and its CSV in ${folder}`,
    search: "csv",
    csvFile: "Check record – Tides.csv",
    pdfFile: "Check record – Tides.pdf",
    secondPdf: "Check record – Tides 2.pdf",
    columns: ["Kind", "Sentence", "Result"],
    supported: "Supported",
    notFound: "Not found",
    unsupported: "Unsupported",
    sentence: "Sentence",
    model: "Model",
    service: "Service",
    checked: "Checked (UTC)",
    thisComputer: "On this computer",
  },
  "zh-CN": {
    entry: "导出核对记录…",
    found: (name: string, folder: string) => `已保存“${name}”和 CSV 文件到“${folder}”`,
    search: "核对记录",
    csvFile: "核对记录 – Tides.csv",
    pdfFile: "核对记录 – Tides.pdf",
    secondPdf: "核对记录 – Tides 2.pdf",
    columns: ["类型", "句子", "核对结果"],
    supported: "有依据",
    notFound: "未找到",
    unsupported: "无依据",
    sentence: "句子",
    model: "模型",
    service: "服务",
    checked: "核对时间（UTC）",
    thisComputer: "在这台电脑上",
  },
} as const;

let dataDir: string;
let sources: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(out);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`one Export check record entry, in the Mind's menu and ⌘K, saves the PDF and its CSV side by side, listing each checked sentence (${language})`, async () => {
    const text = TEXTS[language];
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    await nameMind(window, "Tides");
    const editor = window.getByTestId("mind-editor").filter({ visible: true });
    await editor.click();
    await window.keyboard.type(SENTENCES.join(" "));
    const line = editor.locator(":scope > p").first();
    await slideSelect(window, line, "Spring tides", { line, words: "harbour cliffs." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    const marks = window.getByTestId("claim-mark");
    await expect(marks.and(window.locator("[data-check=supported]"))).toHaveCount(1);
    await expect(marks.and(window.locator("[data-check=unsupported]"))).toHaveCount(1);
    await useOutputLocation(window, out);

    // From the Mind's ⋯ menu: one entry, which saves the PDF and its CSV side by side, said in one line.
    await interceptOpenPath(app);
    const row = window.getByTestId("mind-row").filter({ hasText: "Tides" });
    await pointAt(window, row);
    await pointAndClick(window, row.getByTestId("mind-menu"));
    const menu = row.getByTestId("mind-actions");
    await expect(menu.getByTestId("mind.checkRecord")).toHaveText(text.entry);
    await expect(menu.locator('[data-testid^="mind.checkRecord."]')).toHaveCount(0);
    await pointAndClick(window, menu.getByTestId("mind.checkRecord"));
    const result = window.getByTestId("export-result");
    const done = result.getByTestId("export-done");
    await expect(done).toHaveText(text.found(text.pdfFile, basename(out)), { timeout: 30_000 });
    expect((await readdir(out)).sort()).toEqual([text.csvFile, text.pdfFile].sort());
    const pdf = await readFile(join(out, text.pdfFile));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // Open opens the PDF.
    await result.getByTestId("export-open").click();
    await expect.poll(() => pathsOpened(app)).toEqual([join(await realpath(out), text.pdfFile)]);

    const csv = await readFile(join(out, text.csvFile), "utf8");
    const rows = parseCsv(csv);
    const at = rows.findIndex((each) => each[0] === text.columns[0] && each[1] === text.columns[1]);
    expect(at).toBeGreaterThan(0);
    const [header = [], ...items] = rows.slice(at);
    const column = (name: string) => header.indexOf(name);
    expect(items.map((each) => [each[1], each[2]])).toEqual([
      [SENTENCES[0], text.supported],
      [SENTENCES[1], text.notFound],
    ]);
    // The supported sentence names the Document version it rests on: the file's own fingerprint.
    const sha = createHash("sha256").update(TIDES).digest("hex");
    expect(items[0]?.[column("SHA-256")]).toBe(sha);
    expect(items[0]?.[column(text.model)]).toBe("fake-model");
    expect(items[0]?.[column(text.service)]).toBe(text.thisComputer);
    expect(items[0]?.[column(text.checked)]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(items[1]?.[column("SHA-256")]).toBe("");

    // From ⌘K, found by "csv" (or 核对记录): the same one command, under the next free name.
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(`>${text.search}`);
    const item = window.getByTestId("palette").locator('[data-key="command:mind.checkRecord"]');
    await expect(item).toContainText(text.entry);
    await pointAndClick(window, item);
    await expect(done).toHaveText(text.found(text.secondPdf, basename(out)), { timeout: 30_000 });
    expect(await readdir(out)).toHaveLength(4);

    const keep = process.env.INCARNAMIND_SCREENSHOTS;
    if (keep) {
      await writeFile(join(keep, `check-record-${language}.pdf`), pdf);
      await writeFile(join(keep, `check-record-${language}.csv`), csv);
      await result.screenshot({ path: join(keep, `check-record-line-${language}.png`) });
    }
    await app.close();
  });
}
