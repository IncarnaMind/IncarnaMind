import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  type CrossrefWork,
  type OpenAlexWork,
  type ReferenceServices,
  startReferenceServices,
} from "../tests/helpers/referenceServices";
import {
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  interceptOpenDialog,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Checking a verified document's reference list: the line under its
 * claims says what looking the references up sends, by its button, so
 * clicking it is the consent; then it flags the reference Crossref has no
 * work for. A local stand-in answers for Crossref. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const LSTM: CrossrefWork = {
  DOI: "10.1162/neco.1997.9.8.1735",
  title: ["Long Short-Term Memory"],
  author: [
    { family: "Hochreiter", given: "Sepp" },
    { family: "Schmidhuber", given: "Jürgen" },
  ],
  issued: { "date-parts": [[1997, 11, 1]] },
};
const DEEP: CrossrefWork = {
  DOI: "10.1038/nature14539",
  title: ["Deep learning"],
  author: [
    { family: "LeCun", given: "Yann" },
    { family: "Bengio", given: "Yoshua" },
    { family: "Hinton", given: "Geoffrey" },
  ],
  issued: { "date-parts": [[2015, 5, 27]] },
};
const INVENTED =
  "Marlowe, T. (2019). Quantum gradient folding in recurrent attention lattices. J. Imagined Results, 4.";
/** A conference paper Crossref has no record of, which OpenAlex holds. */
const FEW_SHOT: OpenAlexWork = {
  id: "https://openalex.org/W3030163527",
  doi: "https://doi.org/10.48550/arxiv.2005.14165",
  display_name: "Language Models are Few-Shot Learners",
  publication_date: "2020-05-28",
  authorships: [{ author: { display_name: "Tom B. Brown" } }],
};

/** A short paper someone else wrote, with a reference list holding one invented work. */
const PAPER = buildPdf([
  { lines: ["Memory in networks", "Recurrent networks remember what came before."] },
  {
    lines: [
      "References",
      "Hochreiter, S., & Schmidhuber, J. (1997). Long short-term memory. Neural Computation.",
      "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature. doi:10.1038/nature14539.",
      INVENTED,
      "Brown, T., et al. (2020). Language models are few-shot learners. Advances in NeurIPS, 33.",
    ],
  },
]);

let dataDir: string;
let sources: string;
let services: ReferenceServices;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  services = await startReferenceServices({ works: [LSTM, DEEP], openalex: [FEW_SHOT] });
});
test.afterEach(async () => {
  await services.close();
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** Launches with the scripted model and the Crossref stand-in, and verifies the paper. */
async function verifyPaper(width: number) {
  await writeFile(join(sources, "Memory paper.pdf"), PAPER);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    referenceLookup: services.url,
  });
  await setWindowSize(app, window, width, 900);
  await dismissChatSetup(window);
  // The scripted model, as the Ollama model the setup screen would save, finds the claims.
  await window.evaluate(async () => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
      kind: "ollama",
      modelId: "fake-model",
    });
  });
  await interceptOpenDialog(app, join(sources, "Memory paper.pdf"));
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-more"));
  await pointAndClick(window, window.getByTestId("plus-verify-document"));
  await expect(frontMindName(window)).toHaveText("Checking: Memory paper");
  return { app, window };
}

/** Records each consent request the core raises from now on. */
async function recordConsentRequests(window: Page) {
  await window.evaluate(() => {
    const scope = globalThis as unknown as { incarnamind: CoreBridge; asked: string[] };
    scope.asked = [];
    scope.incarnamind.on("consent.requested", (request) => scope.asked.push(request.flow.id));
  });
  return () => window.evaluate(() => (globalThis as unknown as { asked: string[] }).asked);
}

test("a verified document's references are looked up, and the invented one is flagged", async () => {
  const { app, window } = await verifyPaper(1440);
  const asked = await recordConsentRequests(window);

  const line = window.getByTestId("references-line");
  await expect(line.getByTestId("references-sends")).toHaveText(
    "Sends 4 references, as written, to Crossref, OpenAlex or arXiv.",
  );
  await screenshot(window, "references-start-en");
  await pointAndClick(window, line.getByTestId("references-check"));

  await expect(line.getByTestId("references-done")).toHaveText(
    "Checked 4 references·1 not in Crossref or OpenAlex",
  );
  // The one that needs a look comes first, saying how much its mark can say.
  const listed = window.getByTestId("reference-check");
  await expect(listed).toHaveCount(4);
  const flagged = listed.first();
  await expect(flagged).toHaveAttribute("data-mark", "not-listed");
  await expect(flagged).toContainText("Not in Crossref or OpenAlex");
  await expect(flagged).toContainText("Quantum gradient folding");
  await expect(flagged).toContainText("the work may still exist");
  // The found ones follow, each with the service it was found in, the record and its DOI.
  await expect(listed.nth(1)).toHaveAttribute("data-mark", "found");
  await expect(listed.nth(1)).toContainText("Found in Crossref");
  await expect(listed.nth(3)).toContainText("Found in OpenAlex");
  await expect(listed.nth(3)).toContainText("Language models are few-shot learners");
  const record = window.getByTestId("reference-record").first();
  await expect(record).toContainText(
    "Long Short-Term Memory · Hochreiter, Sepp; Schmidhuber, Jürgen · 1997",
  );
  await expect(record.getByTestId("reference-doi")).toHaveAttribute(
    "href",
    "https://doi.org/10.1162/neco.1997.9.8.1735",
  );
  await screenshot(window, "references-flagged-en");
  // Clicking it is the consent: nothing asked; only the references went, one a request.
  expect(await asked()).toEqual([]);
  expect(services.requests.length).toBeGreaterThanOrEqual(3);
  for (const request of services.requests) {
    expect(decodeURIComponent(request.path)).not.toContain("Recurrent networks remember");
  }

  // Shown by keyboard too: the entry moves to its Block.
  await flagged.focus();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("mind-editor")).toBeFocused();
  await app.close();
});

test("in Chinese and a narrow window, and in local mode, where it says why and offers the way out", async () => {
  const { app, window } = await verifyPaper(900);
  await setLanguage(window, "zh-CN");
  await window.evaluate(async () => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(true);
  });

  const local = window.getByTestId("references-local-mode");
  await expect(local).toContainText("无法查询参考文献：已开启“所有内容都留在这台电脑上”");
  await screenshot(window, "references-local-zh");
  await pointAndClick(window, local.getByTestId("references-local-mode-off"));

  const line = window.getByTestId("references-line");
  await expect(line.getByTestId("references-sends")).toHaveText(
    "会把 4 条参考文献的原文发送给 Crossref、OpenAlex 或 arXiv。",
  );
  await pointAndClick(window, line.getByTestId("references-check"));
  await expect(line.getByTestId("references-done")).toHaveText(
    "已核对 4 条参考文献·1 条在 Crossref 和 OpenAlex 中都没有",
  );
  await expect(window.getByTestId("reference-check").first()).toContainText(
    "Crossref 和 OpenAlex 中都没有",
  );
  await screenshot(window, "references-flagged-zh");
  // Narrow, the line wraps rather than overflowing the check badge's card it is in.
  const lineBox = await line.boundingBox();
  const cardBox = await window.getByTestId("check-card").boundingBox();
  expect((lineBox?.x ?? 0) + (lineBox?.width ?? 0)).toBeLessThanOrEqual(
    (cardBox?.x ?? 0) + (cardBox?.width ?? 0) + 1,
  );
  await app.close();
});

test("Stop ends a check; offline, it stops at the first failure with one problem and Try again", async () => {
  const { app, window } = await verifyPaper(1440);
  const line = window.getByTestId("references-line");

  // A slow Crossref: Stop ends the check where it is, and nothing more is asked.
  const slow = services.pause();
  await pointAndClick(window, line.getByTestId("references-check"));
  await expect(line.getByTestId("references-progress")).toBeVisible();
  await slow.reached;
  await pointAndClick(window, line.getByTestId("references-stop"));
  await expect(line.getByTestId("references-check")).toBeVisible();
  slow.release();
  expect(services.requests).toHaveLength(1);

  // Offline: one request fails, the rest aren't sent, and one problem says so.
  services.fail("unreachable");
  await pointAndClick(window, line.getByTestId("references-check"));
  const stopped = window.getByTestId("references-stopped");
  await expect(stopped).toContainText("Crossref couldn’t be reached.");
  await expect(window.getByTestId("reference-check")).toHaveCount(0);
  expect(services.requests).toHaveLength(2);
  await screenshot(window, "references-offline-en");

  // Back online, Try again checks them.
  services.fail(null);
  await pointAndClick(window, stopped.getByTestId("references-try-again"));
  await expect(line.getByTestId("references-done")).toHaveText(
    "Checked 4 references·1 not in Crossref or OpenAlex",
  );
  await expect(stopped).toHaveCount(0);
  await app.close();
});
