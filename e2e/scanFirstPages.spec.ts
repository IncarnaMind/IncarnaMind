/**
 * A dropped scan is sorted from its first pages while the rest is read (#2308): its Library row
 * shows the Folder Organize suggested beside "Reading N/M", and keeps it once the rest is read.
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  createDataFolder,
  decisionServer,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setWindowSize,
} from "./app";

const picture = readFileSync(join(__dirname, "../tests/fixtures/scans/en-clean.jpg"));

const CASES = {
  en: {
    cover: [
      "Invoice 2207 from Larkspur Marine Supply.",
      "Payment for the berth fenders is due within 30 days.",
      "The delivery notes follow on the scanned sheets.",
    ],
    sheet: (page: number) =>
      Array.from(
        { length: 16 },
        (_, line) =>
          `Sheet ${page}, line ${line + 1}: a delivery note for the fenders, copied by the clerk on duty from the carbon kept at the store.`,
      ),
    says: "invoice",
    reading: /^Reading \d+\/39/,
    suggested: "Suggested",
  },
  "zh-CN": {
    cover: [
      "青禾船舶用品公司发票第 2207 号。",
      "码头护舷的货款须在 30 天内付清。",
      "送货单附在后面的扫描页上。",
    ],
    sheet: (page: number) =>
      Array.from(
        { length: 16 },
        (_, line) =>
          `第 ${page} 页第 ${line + 1} 行：值班记录员从仓库留存的复写联抄录的护舷送货单，数量和日期已核对并签名。`,
      ),
    says: "发票",
    reading: /^识别中 \d+\/39/,
    suggested: "推荐",
  },
} as const;

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

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: a scan is sorted from its first pages while the rest is read`, async () => {
    test.setTimeout(180_000);
    const words = CASES[language];
    const { server } = await decisionServer((text) =>
      text.includes(words.says) ? "Finance" : "Reports",
    );
    const script = join(sources, "scans.json");
    await writeFile(
      script,
      JSON.stringify({
        pages: Object.fromEntries(
          Array.from({ length: 39 }, (_, index) => [index + 2, { lines: words.sheet(index + 2) }]),
        ),
      }),
    );
    const file = join(sources, "Fender delivery.pdf");
    const cover = language === "en" ? { lines: words.cover } : { chineseLines: words.cover };
    await writeFile(
      file,
      buildPdf([cover, ...Array.from({ length: 39 }, () => ({ scan: picture }))]),
    );
    const { app, window } = await launchApp(dataDir, { scans: script, scansAtOnce: 1 });
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1400, 900);
      const port = (server.address() as AddressInfo).port;
      await window.evaluate(
        async ({ url, chosen }) => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await core.updateSettings({ user: { language: chosen } });
          for (const name of ["Finance", "Reports"])
            await core.createLibraryGroup({ name, description: `${name} documents` });
          await core.saveLibrarySettings({
            classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
            automatic: true,
            turnOn: true,
          });
        },
        { url: `http://127.0.0.1:${port}`, chosen: language },
      );
      await window.getByTestId("open-library").click();
      await window.evaluate(async (path) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.addDocuments([path]);
      }, file);

      const row = window
        .getByTestId("library-document")
        .filter({ hasText: "Fender delivery" })
        .first();
      const suggested = row.getByTestId("library-suggested");
      const status = row.getByTestId("document-status");
      // Sorted while the rest is read: the Folder's mark and the reading progress, on one line.
      await expect(suggested).toHaveText(words.suggested, { timeout: 90_000 });
      await expect(status).toHaveText(words.reading);
      const [mark, progress] = await Promise.all([suggested.boundingBox(), status.boundingBox()]);
      if (!mark || !progress) throw new Error("The row's mark or progress isn't shown.");
      expect(Math.abs(mark.y + mark.height / 2 - (progress.y + progress.height / 2))).toBeLessThan(
        progress.height,
      );
      await expect(suggested).toHaveAttribute("title", /Finance/);

      // Read whole: the progress goes, and the Folder stays as it was.
      await expect(status).not.toHaveText(words.reading, { timeout: 120_000 });
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            return (await core.listDocuments()).map((each) => each.status);
          }),
        )
        .toEqual(["ready"]);
      await expect(suggested).toHaveText(words.suggested);
      await expect(suggested).toHaveAttribute("title", /Finance/);
    } finally {
      await app.close();
      server.close();
    }
  });
}
