import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { paragraph, run, wordFile } from "../tests/helpers/word";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  fontsDrawing,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

let dataDir: string;
let files: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  files = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(files);
});

/** Office's names, and the app's own font list (styles.css): a face may carry neither name. */
const OFFICE_NAMES = [
  "Segoe UI",
  "Calibri",
  "Calibri Light",
  "Cambria",
  "Aptos",
  "Aptos Display",
  "Aptos Narrow",
];
const SYSTEM =
  /^-apple-system, (?:BlinkMacSystemFont|"system-ui"), "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif$/;

test("a Word page's Office faces are the viewer's alone, and the app's own font and weights are unchanged", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("# Chrome");
  const heading = editor.locator("h1");
  await expect(heading).toHaveText("Chrome");

  // A Word page that names Office fonts: the viewer draws it, so its faces load app-wide if they can.
  const file = join(files, "Office faces.docx");
  await writeFile(
    file,
    wordFile({
      body: `${paragraph(run("Segoe UI memo", { font: "Segoe UI" }))}${paragraph(
        run("Calibri figure", { font: "Calibri" }),
      )}`,
    }),
  );
  await addDocuments(window, [file]);
  const row = window.getByTestId("document-list-item").filter({ hasText: "Office faces" });
  await pointAndClick(window, row.getByTestId("open-document"));
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByText("Segoe UI memo")).toBeVisible();

  // Every Office face is registered under the viewer's prefix, and none under Office's own name:
  // a face named "Segoe UI" here would draw the app's own text with these two weights, or Carlito.
  const families = await window.evaluate(() => [...document.fonts].map((face) => face.family));
  for (const name of OFFICE_NAMES) expect(families).not.toContain(name);
  expect(families).toContain("IncarnaMind Office Segoe UI");
  expect(families).toContain("IncarnaMind Office Calibri");

  // Back on the Mind: its title is the system's font at 600, drawn by no face of the viewer's.
  await pointAndClick(window, window.getByTestId("mind-tab").first());
  await expect(heading).toBeVisible();
  const style = await heading.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      family: computed.fontFamily,
      weight: Number.parseInt(computed.fontWeight, 10),
    };
  });
  expect(style.family).toMatch(SYSTEM);
  expect(style.weight).toBe(600);
  expect(
    (await fontsDrawing(window, '[data-testid="mind-editor"] h1')).filter((font) => font.bundled),
  ).toEqual([]);
  const sidebar = await window
    .getByTestId("sidebar")
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(sidebar).toMatch(SYSTEM);
  await app.close();
});

/** A Word file whose body font comes only from its theme, as most Word files' do. */
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
  <a:themeElements>
    <a:fontScheme name="Office">
      <a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`;
const THEME_STYLES = `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:eastAsiaTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>`;

test("a Word file whose font comes only from its theme is drawn with the viewer's stand-in, not Times", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  const file = join(files, "Theme font.docx");
  await writeFile(
    file,
    wordFile({
      styles: THEME_STYLES,
      body: paragraph("Theme font memo"),
      rels: `<Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
      parts: [{ name: "word/theme/theme1.xml", data: THEME }],
    }),
  );
  await addDocuments(window, [file]);
  await pointAndClick(
    window,
    window
      .getByTestId("document-list-item")
      .filter({ hasText: "Theme font" })
      .getByTestId("open-document"),
  );
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByText("Theme font memo")).toBeVisible();
  const drawn = await fontsDrawing(window, '[data-testid="viewer"] .docx-view p');
  expect(drawn.map((font) => font.name.toLowerCase())).not.toContain("timesnewromanpsmt");
  expect(drawn.map((font) => font.name.toLowerCase()).some((name) => name.includes("times"))).toBe(
    false,
  );
  expect(drawn.some((font) => font.bundled && /carlito/i.test(font.family))).toBe(true);
  await app.close();
});
