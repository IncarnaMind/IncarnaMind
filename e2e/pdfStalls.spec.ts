import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  interceptOpenPath,
  launchApp,
  pathsOpened,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setViewerOpenLimitMs,
} from "./app";

/*
 * A PDF whose open never finishes (#2828): pdf.js waits with no limit of its own for its worker
 * and for the file's bytes. Past the viewer's limit, "Opening the Document…" gives way to a
 * Problem line with one way on, Open in default app, in English and Chinese.
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

const LIMIT_MS = 1500;

/** Every Document's file sends its first bytes, then nothing more, as a read that stalls does. */
async function stallDocumentFiles(app: ElectronApplication, window: Page): Promise<void> {
  await app.evaluate(({ protocol }) => {
    protocol.unhandle("incarnamind-document");
    protocol.handle(
      "incarnamind-document",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("%PDF-1.4\n"));
            },
            pull: () => new Promise<void>(() => {}),
          }),
          { status: 200, headers: { "Content-Type": "application/pdf", "Content-Length": "5000" } },
        ),
    );
  });
  // A page keeps the scheme's handler it loaded with: the stall reaches the page from its next load.
  await window.reload();
}

/** pdf.js's worker starts and never answers. */
const silenceWorkers = (window: Page) =>
  window.evaluate(() => {
    class SilentWorker extends EventTarget {
      postMessage(): void {}
      terminate(): void {}
    }
    globalThis.Worker = SilentWorker as unknown as typeof Worker;
  });

async function addReport(window: Page): Promise<string> {
  const file = join(sources, "Report.pdf");
  await writeFile(file, buildPdf([{ lines: ["Quarterly report", "Prepared for the board."] }]));
  await dismissChatSetup(window);
  await addDocuments(window, [file]);
  return file;
}

async function openReport(window: Page): Promise<void> {
  await setViewerOpenLimitMs(window, LIMIT_MS);
  const item = window.getByTestId("document-list-item").filter({ hasText: "Report" });
  await pointAndClick(window, item.getByTestId("open-document"));
  await expect(window.getByTestId("viewer-title")).toHaveText("Report");
}

async function expectProblemLine(app: ElectronApplication, window: Page, file: string) {
  const viewer = window.getByTestId("viewer");
  const line = viewer.getByTestId("viewer-not-opened");
  await expect(line).toBeVisible();
  await expect(viewer.getByText("Opening the Document…")).toHaveCount(0);
  await expect(line).toContainText("IncarnaMind couldn’t open this PDF.");
  const open = line.getByTestId("viewer-not-opened-open");
  await expect(open).toHaveText("Open in default app");

  await setLanguage(window, "zh-CN");
  await expect(line).toContainText("IncarnaMind 无法打开这个 PDF。");
  await expect(open).toHaveText("用默认应用打开");

  await interceptOpenPath(app);
  await pointAndClick(window, open);
  await expect
    .poll(async () => (await pathsOpened(app)).map((path) => basename(path)))
    .toEqual([basename(file)]);
}

test("a PDF whose file stops arriving says IncarnaMind couldn't open it, and opens in its default app, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    const file = await addReport(window);
    await stallDocumentFiles(app, window);
    await openReport(window);
    await expect(window.getByTestId("viewer").getByText("Opening the Document…")).toBeVisible();
    await expectProblemLine(app, window, file);
  } finally {
    await app.close();
  }
});

test("a PDF whose pdf.js worker never answers says IncarnaMind couldn't open it, and opens in its default app, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    const file = await addReport(window);
    await silenceWorkers(window);
    await openReport(window);
    await expectProblemLine(app, window, file);
  } finally {
    await app.close();
  }
});
