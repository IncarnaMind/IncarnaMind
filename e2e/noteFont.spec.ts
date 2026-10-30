import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { MindStyle, TextSize } from "../src/shared/mindStyle";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  clickEndOf,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * What a Mind's page draws under its writing (footnotes, the footnote area, References and
 * table text) is in the Mind's font and keeps its size a step below the writing's, at every
 * text size (#1057).
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const WORDS = {
  en: { line: "Spring tides come at new moon", note: "Twice a month." },
  "zh-CN": { line: "大潮在新月和满月时出现", note: "每月两次。" },
} as const;

const CANDIDATES = [
  "Georgia",
  "DejaVu Serif",
  "Liberation Serif",
  "Times New Roman",
  "DejaVu Sans",
  "Arial",
];

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await target.screenshot({ path: join(folder, `${name}.png`) });
}

const typeOf = (target: Locator) =>
  target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      family: style.fontFamily,
      size: Number.parseFloat(style.fontSize),
      leading: Number.parseFloat(style.lineHeight),
    };
  });

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SIZES: TextSize[] = ["default", "small", "large"];

for (const { language, width } of [
  { language: "en", width: 1280 },
  { language: "zh-CN", width: 900 },
] as const) {
  test(`footnotes, References and table text are in the Mind's font, a step below its writing at Small, Default and Large (${language}, ${width} px)`, async () => {
    const words = WORDS[language];
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await useLocalChatModel(window);
    await setWindowSize(app, window, width, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("# Tides");
    await window.keyboard.press("Enter");
    await window.keyboard.type(words.line);
    await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
    await expect(editor.getByTestId("citation").first()).toBeVisible();

    // A footnote of the User's own, written in its popover; then a table under the first line.
    const first = editor.locator(":scope > p").first();
    await clickEndOf(window, first);
    await window.keyboard.type(language === "zh-CN" ? "/脚注" : "/footnote");
    await window.keyboard.press("Enter");
    const popover = window.getByTestId("footnote-popover");
    await expect(popover.getByTestId("footnote-text")).toBeFocused();
    await window.keyboard.type(words.note);
    await window.keyboard.press("Enter");
    await expect(popover).toHaveCount(0);
    await window.keyboard.press("Enter");
    await window.keyboard.type("/table");
    await window.keyboard.press("Enter");
    const cell = editor.locator("table td").first();
    await expect(cell).toBeVisible();

    // A note style makes the Citation a footnote too, and gives the Mind its References.
    const mindId = (await (await coreOf(window)).evaluate((core) => core.listMinds()))[0]?.id ?? "";
    await (await coreOf(window)).evaluate(
      (core, id) => core.setMindCitationStyle(id, "chicago-notes"),
      mindId,
    );
    const area = window.getByTestId("footnote-area");
    const references = window.getByTestId("references");
    await expect(area.locator(".footnote-area-source")).toHaveCount(1);
    await expect(references.getByTestId("reference-entry")).toHaveCount(1);

    const installedFamilies = await window.evaluate(async () =>
      (
        await (
          globalThis as unknown as { queryLocalFonts(): Promise<{ family: string }[]> }
        ).queryLocalFonts()
      ).map((font) => font.family),
    );
    const installed =
      CANDIDATES.find((family) => installedFamilies.includes(family)) ?? installedFamilies[0] ?? "";
    expect(installed).not.toBe("");

    const fonts: { name: string; font: MindStyle["font"]; drawn: (family: string) => boolean }[] = [
      {
        name: "Default",
        font: "default",
        drawn: (family) => !/Source Serif 4|JetBrains Mono/.test(family),
      },
      { name: "Serif", font: "serif", drawn: (family) => /^"?Source Serif 4"?,/.test(family) },
      { name: "Mono", font: "mono", drawn: (family) => /^"?JetBrains Mono"?,/.test(family) },
      {
        name: installed,
        font: { family: installed },
        drawn: (family) => new RegExp(`^"?${escaped(installed)}"?,`).test(family),
      },
    ];

    for (const { name, font, drawn } of fonts) {
      let reference = 0;
      const bodies: Partial<Record<TextSize, number>> = {};
      for (const size of SIZES) {
        await (await coreOf(window)).evaluate(
          (core, [id, style]) => core.setMindStyle(id as string, style as MindStyle),
          [mindId, { font, size }] as const,
        );
        const sizeOfDefault = bodies.default;
        await expect
          .poll(async () => {
            const now = await typeOf(first);
            return drawn(now.family) && (sizeOfDefault === undefined || now.size !== sizeOfDefault);
          })
          .toBe(true);
        const body = await typeOf(first);
        bodies[size] = body.size;
        expect(drawn(body.family), `${name}: the writing is ${body.family}`).toBe(true);
        if (sizeOfDefault !== undefined) {
          expect(size === "small" ? body.size < sizeOfDefault : body.size > sizeOfDefault).toBe(
            true,
          );
        }

        await pointAndClick(window, editor.getByTestId("footnote-marker").first());
        await expect(popover).toBeVisible();
        await motionSettled(window);
        const drawing = {
          footnote: popover.getByTestId("footnote-text"),
          area: area.getByTestId("footnote-row").getByTestId("footnote-text").first(),
          source: area.locator(".footnote-area-source"),
          references: references.getByTestId("reference-entry").first(),
          table: cell,
        };
        for (const [place, target] of Object.entries(drawing)) {
          const note = await typeOf(target);
          const label = `${name}, ${size}, ${place}`;
          expect(note.family, label).toBe(body.family);
          expect(note.size, label).toBeLessThan(body.size);
          expect(note.leading, label).toBeLessThan(body.leading);
          if (size === "default") {
            reference = note.size / body.size;
          } else {
            expect(Math.abs(note.size / body.size - reference), label).toBeLessThan(0.03);
          }
        }

        // The footnote area's number sits level with its text's first line.
        const number = await area.getByTestId("footnote-row-number").first().boundingBox();
        const text = await drawing.area.boundingBox();
        const line = (await typeOf(drawing.area)).leading;
        if (!number || !text) throw new Error("The footnote area isn't showing.");
        expect(Math.abs(number.height - line)).toBeLessThanOrEqual(1);
        expect(Math.abs(number.y - text.y)).toBeLessThanOrEqual(2);

        await window.keyboard.press("Escape");
        await expect(popover).toHaveCount(0);
      }
    }

    // The References block and footnotes under Serif at Large, as a person sees them.
    await (await coreOf(window)).evaluate(
      (core, id) => core.setMindStyle(id, { font: "serif", size: "large" }),
      mindId,
    );
    await references.scrollIntoViewIfNeeded();
    await screenshot(window, `note-font-serif-large-${language}-${width}`);
    await app.close();
  });
}
