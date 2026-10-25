import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/**
 * A check run on a small model on this computer carries one quiet line saying
 * its verdicts may be wrong (#680). The scripted chat model answers; a tiny
 * stand-in for Ollama reports the model's size: 4B gets the line, 30B doesn't.
 */

const TIDES = buildPdf([
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);
const SENTENCE = "Spring tides happen at new and full moon.";

const NOTICE = {
  en: "Small model: its verdicts may be wrong. A larger one is more reliable.",
  "zh-CN": "模型较小，结论可能不准，换更大的模型更可靠。",
} as const;

let dataDir: string;
let sources: string;
let stop: () => Promise<void>;
let baseUrl: string;

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  const sizes: Record<string, string> = { "scripted-4b": "4.5B", "scripted-30b": "30B" };
  const server = createServer((request, response) => {
    const send = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/api/tags") {
      send({
        models: Object.entries(sizes).map(([name, size]) => ({
          name,
          model: name,
          size: 1_000_000_000,
          digest: name,
          details: { parameter_size: size },
        })),
      });
    } else if (request.url === "/api/show") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const name = (JSON.parse(body) as { model?: string }).model ?? "";
        send({
          capabilities: ["completion", "tools"],
          details: { parameter_size: sizes[name] ?? "" },
          model_info: {},
        });
      });
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
});
test.afterEach(async () => {
  await stop();
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function checkSelection(window: Page, modelId: string) {
  await window.evaluate(
    async ({ model, url }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({ kind: "ollama", baseUrl: url, modelId: model });
    },
    { model: modelId, url: baseUrl },
  );
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(SENTENCE);
  const line = editor.locator(":scope > p").first();
  await expect(line).toHaveText(SENTENCE);
  await slideSelect(window, line, "Spring tides", { line, words: "full moon." });
  const menu = window.getByTestId("selection-menu");
  await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));
  await expect(window.getByTestId("claim-mark")).toHaveCount(1);
  await expect((await checkCard(window)).getByTestId("mind-health")).toBeVisible();
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Check against Documents on a 4B model says its verdicts may be wrong, and on a 30B model doesn't, in ${language}`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await setLanguage(window, language);

    await checkSelection(window, "scripted-4b");
    const notice = window.getByTestId("checks-small-model");
    await expect(notice).toHaveText(NOTICE[language]);
    // Quiet: in the badge's card under its rows, without covering them, and not a problem.
    const health = await window.getByTestId("mind-health").boundingBox();
    const line = await notice.boundingBox();
    if (!health || !line) throw new Error("The lines aren't drawn.");
    const apart = line.x >= health.x + health.width - 1 || line.y >= health.y + health.height - 1;
    expect(apart).toBe(true);
    await expect(window.getByTestId("checks-problem")).toHaveCount(0);
    await app.close();
  });

  test(`a 30B model's verdicts carry no line, in ${language}`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await setLanguage(window, language);

    await checkSelection(window, "scripted-30b");
    await expect(window.getByTestId("checks-small-model")).toHaveCount(0);
    await app.close();
  });
}
