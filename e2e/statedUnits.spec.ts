import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  mindWrittenBefore,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A figure written as its Document writes it, in the unit the Document states, is never
 * Contradicted (#2864). Against a PDF in GBP million (人民币百万元), the Note's bare "668.3" is
 * Supported and its card names the unit; the planted "£538.9m" against 528.9 is Contradicted. The
 * scripted model binds each figure to its line and quotes the PDF's unit line
 * (src/main/fakeChat/checks.ts). English and Chinese, wide and narrow.
 */
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

const CASES = {
  en: {
    file: "Harbourline half-year update.pdf",
    pdf: buildPdf([
      {
        lines: [
          "Harbourline Foods plc half-year update",
          "All figures in GBP million unless stated otherwise",
          "Revenue for the six months was 668.3.",
          "Net debt at 30 June 2026 was 528.9.",
        ],
      },
    ]),
    unitOnly: "Revenue for the six months: 668.3",
    planted: "Net debt at 30 June 2026 was £538.9m.",
    figure: "668.3",
    unit: "GBP million",
  },
  "zh-CN": {
    file: "华岭食品年报摘要.pdf",
    pdf: buildPdf([
      {
        chineseLines: [
          "华岭食品2025年年度报告摘要",
          "单位：人民币百万元",
          "2025年全年营业收入为187.3。",
          "2025年12月31日净负债为502.4。",
        ],
      },
    ]),
    unitOnly: "2025年全年营业收入为187.3。",
    planted: "2025年12月31日净负债为512.4百万元。",
    figure: "187.3",
    unit: "人民币百万元",
  },
} as const;

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`a figure in the unit its Document states is Supported and names it; a real difference stays Contradicted (${language}, ${width}px)`, async () => {
    test.setTimeout(120_000);
    const each = CASES[language];
    await writeFile(join(sources, each.file), each.pdf);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setWindowSize(app, window, width, 900);
      await setLanguage(window, language);
      await addDocuments(window, [join(sources, each.file)]);
      await mindWrittenBefore(window, "Key figures", [
        { note: each.unitOnly },
        { note: each.planted },
      ]);
      await window.getByTestId("mind-list-item").filter({ hasText: "Key figures" }).click();
      await runCommand(window, "mind.check", translate(language, "mindCheck.command"));

      const marks = window.getByTestId("claim-mark");
      await expect(marks).toHaveCount(2);
      await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
      await expect(marks.nth(1)).toHaveAttribute("data-check", "contradicted");

      await pointAndClick(window, marks.nth(0));
      const card = window.getByTestId("claim-card");
      await expect(card.getByTestId("claim-badge")).toHaveText(
        translate(language, "claim.state.supported"),
      );
      await expect(card.getByTestId("claim-stated-unit")).toHaveText(
        translate(language, "figures.card.statedUnit", { figure: each.figure, unit: each.unit }),
      );
      const box = await card.getByTestId("claim-stated-unit").boundingBox();
      const cardBox = await card.boundingBox();
      if (!box || !cardBox) throw new Error("The card's unit line is not drawn.");
      expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);

      await pointAndClick(window, marks.nth(1));
      await expect(card.getByTestId("claim-badge")).toHaveText(
        translate(language, "claim.state.contradicted"),
      );
      await expect(card.getByTestId("claim-stated-unit")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}
