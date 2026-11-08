import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  mindWrittenBefore,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A figure written as its Document writes it, in the unit the Document states, is never
 * Contradicted (#2864). Against a PDF in GBP million, the Note's bare "668.3" is Supported and its
 * card names the unit, "91,500" against 91.5 needs a look because its units may differ, and the
 * planted "£538.9m" against 528.9 is Contradicted. The scripted model binds each figure to its line
 * and quotes the PDF's unit line (src/main/fakeChat/checks.ts). The English and Chinese
 * interfaces, wide and narrow.
 */
const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const shot = async (window: Page, name: string) => {
  if (!SHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
};

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

const FILE = "Harbourline half-year update.pdf";
const PDF = buildPdf([
  {
    lines: [
      "Harbourline Foods plc half-year update",
      "All figures in GBP million unless stated otherwise",
      "Revenue for the six months was 668.3.",
      "Adjusted EBITDA for the six months was 91.5.",
      "Net debt at 30 June 2026 was 528.9.",
    ],
  },
]);

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`a figure in the unit its Document states is Supported and names it, one a unit away needs a look, and a real difference stays Contradicted (${language}, ${width}px)`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, FILE), PDF);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setWindowSize(app, window, width, 900);
      await setLanguage(window, language);
      await addDocuments(window, [join(sources, FILE)]);
      await mindWrittenBefore(window, "Key figures", [
        { note: "Revenue for the six months: 668.3" },
        { note: "Adjusted EBITDA for the six months: 91,500" },
        { note: "Net debt at 30 June 2026 was £538.9m." },
      ]);
      await window.getByTestId("mind-list-item").filter({ hasText: "Key figures" }).click();
      await runCommand(window, "mind.check", translate(language, "mindCheck.command"));

      const marks = window.getByTestId("claim-mark");
      await expect(marks).toHaveCount(3);
      await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
      await expect(marks.nth(1)).toHaveAttribute("data-check", "unsupported");
      await expect(marks.nth(2)).toHaveAttribute("data-check", "contradicted");

      await pointAndClick(window, marks.nth(0));
      const card = window.getByTestId("claim-card");
      await expect(card.getByTestId("claim-badge")).toHaveText(
        translate(language, "claim.state.supported"),
      );
      await expect(card.getByTestId("claim-stated-unit")).toHaveText(
        translate(language, "figures.card.statedUnit", { figure: "668.3", unit: "GBP million" }),
      );
      await shot(window, `stated-unit-${language}`);
      const line = await card.getByTestId("claim-stated-unit").boundingBox();
      const cardBox = await card.boundingBox();
      if (!line || !cardBox) throw new Error("The card's unit line is not drawn.");
      expect(line.x + line.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);

      await pointAndClick(window, marks.nth(1));
      await expect(card.getByTestId("claim-badge")).toHaveText(
        translate(language, "claim.state.unitsMayDiffer"),
      );
      const part = card.getByTestId("claim-part");
      await expect(part).toContainText(translate(language, "claim.state.unitsMayDiffer"));
      await expect(part.getByTestId("claim-part-reason")).toHaveText(
        translate(language, "claim.unsupported.unitsMayDiffer", { amount: "91,500,000" }),
      );
      await shot(window, `units-may-differ-${language}`);
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);

      await pointAndClick(window, marks.nth(2));
      await expect(card.getByTestId("claim-badge")).toHaveText(
        translate(language, "claim.state.contradicted"),
      );
      await expect(card.getByTestId("claim-stated-unit")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}
