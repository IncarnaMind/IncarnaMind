/**
 * Records #1481 in the built app and the interactive prototype. Build the test
 * app first, then run with e2e/demo/playwright.demo.config.ts. Test data and
 * the scripted model only; CORRECTION_OUT names the artifact folder.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CitationAttributes, CoreBridge } from "../../src/core/api";
import {
  addDocuments,
  checkCard,
  useLocalChatModel as chooseScriptedModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "../app";
import { encodeGif, encodeMp4, FILMED, Film, Hand, installOverlay, renderPills } from "./film";

const OUT = process.env.CORRECTION_OUT ?? resolve(__dirname, "claimCorrections-out");
const PROTO = "/Users/joeyxiong/Desktop/code/IncarnaMind/internal/prototypes/simplified/index.html";
const GIF = { fps: 12, width: 1100, colors: 128 };
const PARK = { x: 640, y: 560 };
const CAPTIONS = {
  app: "Built app — correct from the Documents",
  card: "Change only the contradicted part",
  applied: "AI text, its Citation and one Undo",
  badge: "The same correction from the badge",
  proto: "Interactive prototype — the same flow",
  protoCard: "Change to 38.6%",
  protoBadge: "Correct 1 from the Documents",
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

async function built(language: "en" | "zh-CN", width: number) {
  await writeFile(
    join(sources, "Q3 results.txt"),
    "Gross margin fell to 38.6% in Q3, mostly in online.\n",
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await chooseScriptedModel(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, FILMED.height);
  await addDocuments(window, [join(sources, "Q3 results.txt")]);
  const [document] = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  if (!document) throw new Error("The test Document wasn't added.");
  const evidence: CitationAttributes = {
    passageId: "passage-q3",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    pageFrom: 1,
    pageTo: 1,
    location: null,
    quote: "Gross margin fell to 38.6% in Q3, mostly in online.",
    check: "found",
    checkReason: null,
  };
  await newMind(window);
  const text = "Gross margin fell to 36.8% in Q3, mostly in online.";
  const result = {
    reason: null,
    detail: null,
    evidence,
    says: "The results say gross margin was 38.6% in Q3, not 36.8%.",
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [],
    excluded: [],
  };
  const mark = {
    type: "claimCheck",
    attrs: {
      id: "correction-demo",
      request: "correction-demo-request",
      action: "check-against-documents",
      state: "contradicted",
      providerId: "anthropic",
      modelId: "claude-haiku-5-5",
      text,
      ...result,
      scope: { folderId: null, widened: false },
      checkedAt: new Date(Date.now() + 60_000).toISOString(),
      parts: [
        {
          ...result,
          span: { start: 0, end: text.length },
          kind: "fact",
          verdict: "contradicted",
          evidence: [evidence],
          decidingEvidence: 0,
          correction: { from: "36.8%", choices: [{ wording: "38.6%", evidence }] },
        },
      ],
    },
  };
  await window.getByTestId("mind-editor").evaluate(
    (dom, content) => {
      (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
    },
    [
      {
        type: "paragraph",
        content: [{ type: "text", text, marks: [mark] }],
      },
    ],
  );
  const editor = window.getByTestId("mind-editor");
  await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted");
  return { app, window, editor };
}

async function captureCard(window: Page, name: string) {
  await motionSettled(window);
  await window.screenshot({ path: join(OUT, `${name}.png`) });
}

test("captures the built card, badge and corrected sentence", async () => {
  const language = process.env.CORRECTION_LANGUAGE === "zh-CN" ? "zh-CN" : "en";
  const width = Number(process.env.CORRECTION_WIDTH ?? 1440);
  const baseline = process.env.CORRECTION_BASELINE === "1";
  const prefix = baseline ? "before" : "after";
  await mkdir(OUT, { recursive: true });
  const { app, window, editor } = await built(language, width);
  try {
    await window.getByTestId("claim-mark").click();
    await expect(window.getByTestId("claim-card")).toBeVisible();
    await captureCard(window, `${prefix}-card-${language}-${width}`);
    if (!baseline) {
      await window.getByTestId("claim-correct").click();
      await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported");
      await captureCard(window, `${prefix}-applied-${language}-${width}`);
      await window.getByTestId("undo-action").click();
      await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted");
    } else {
      await expect(window.getByTestId("claim-correct")).toHaveCount(0);
      await window.keyboard.press("Escape");
    }
    const badge = await checkCard(window);
    await captureCard(window, `${prefix}-badge-${language}-${width}`);
    if (baseline) await expect(badge.getByTestId("badge-correct-contradictions")).toHaveCount(0);
    await expect(editor).toBeVisible();
  } finally {
    await app.close();
  }
});

test("records the built correction flow", async () => {
  test.setTimeout(600_000);
  await mkdir(OUT, { recursive: true });
  const { app, window } = await built("en", FILMED.width);
  try {
    await installOverlay(window);
    const pills = await renderPills(Object.values(CAPTIONS), join(OUT, "pills"));
    const film = await Film.start(window, join(OUT, "frames-app"), pills);
    const hand = new Hand(window, film);
    await hand.place(PARK.x, PARK.y);
    await hand.begin();
    hand.caption(CAPTIONS.app);
    await hand.hold(700);
    await hand.click(window.getByTestId("claim-mark"));
    hand.caption(CAPTIONS.card);
    await hand.hold(1300);
    await hand.click(window.getByTestId("claim-correct"));
    await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported");
    hand.caption(CAPTIONS.applied);
    await hand.hold(1600);
    await hand.click(window.getByTestId("undo-action"));
    await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted");
    await hand.click(window.getByTestId("check-badge-open"));
    hand.caption(CAPTIONS.badge);
    await hand.hold(1000);
    await hand.click(window.getByTestId("badge-correct-contradictions"));
    await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported");
    await hand.hold(1500);
    await film.stop();
    const master = join(OUT, "app-master.mp4");
    await film.master(master);
    await encodeMp4(master, join(OUT, "app.mp4"));
    await encodeGif(master, join(OUT, "app.gif"), [[0, film.kept]], GIF);
  } finally {
    await app.close();
  }
});

test("records the prototype's correction flow", async () => {
  test.setTimeout(600_000);
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: FILMED.width * 2, height: FILMED.height * 2 },
      deviceScaleFactor: 1,
    });
    await page.goto(`file://${PROTO}`);
    await page.evaluate(() => {
      (globalThis as unknown as { IM: { reset(kind: string): void } }).IM.reset("newuser");
    });
    const mark = page.locator('[data-act="mark"][data-s="s_contra"]');
    await expect(mark).toBeVisible();
    await installOverlay(page);
    const pills = await renderPills(Object.values(CAPTIONS), join(OUT, "pills-prototype"));
    const film = await Film.start(page, join(OUT, "frames-prototype"), pills);
    const hand = new Hand(page, film);
    await hand.place(PARK.x, PARK.y);
    await hand.begin();
    hand.caption(CAPTIONS.proto);
    await hand.hold(700);
    await hand.click(mark);
    hand.caption(CAPTIONS.protoCard);
    await hand.hold(1300);
    await hand.click(page.locator('[data-act="mk.fix"]'));
    hand.caption(CAPTIONS.applied);
    await hand.hold(1600);
    await hand.click(page.locator('[data-act="foot.undo"]'));
    await hand.click(page.locator('.badge[data-act="badge"]').first());
    hand.caption(CAPTIONS.protoBadge);
    await hand.hold(1000);
    await hand.click(page.locator('[data-act="bc.fixAll"]'));
    await hand.hold(1500);
    await film.stop();
    const master = join(OUT, "prototype-master.mp4");
    await film.master(master);
    await encodeMp4(master, join(OUT, "prototype.mp4"));
    await encodeGif(master, join(OUT, "prototype.gif"), [[0, film.kept]], GIF);
  } finally {
    await browser.close();
  }
});
