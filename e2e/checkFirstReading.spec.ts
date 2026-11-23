import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { type MessageKey, translate } from "../src/shared/i18n";
import {
  useLocalChatModel as chooseScriptedModel,
  createDataFolder,
  dismissChatSetup,
  film,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sizeMind,
} from "./app";

/*
 * A decision model's first reading of a sentence (#3118): what it leans to while the AI model
 * still checks the sentence, and after that check ended with no verdict. It shows as a dashed ring
 * in the meta ink holding a tick or a "≠", never in a verdict's colour, and its card says it is a
 * first reading and by which model. A sentence nobody read keeps no mark, and its card the solid
 * ring of Not checked. The checks are written into the page, so no model is involved.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const WORDS = {
  en: {
    likely: "Underlying EBITDA was 96 million in the quarter.",
    against: "The group closed 14 stores in the quarter.",
    unconfirmed: "By September the stores employed 5,200 people.",
    plain: "The board meets again in January.",
  },
  "zh-CN": {
    likely: "本季度基础 EBITDA 为 9,600 万。",
    against: "本季度集团关闭了 14 家门店。",
    unconfirmed: "截至九月，门店员工有 5,200 人。",
    plain: "董事会将于一月再次开会。",
  },
} as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const CHECKED_AT = "2026-11-15T09:30:00.000Z";
const DECISION_MODEL = { providerId: "openrouter", modelId: "perplexity/pplx-decider-v1.2" };
const TIMED_OUT = { reason: "timed-out", detail: "60" };

/** A sentence's check with no verdict: still running, or ended on a timeout, read first or not. */
const unsettled = (
  id: string,
  text: string,
  state: "checking" | "not-checked",
  leaning: "supported" | "contradicted" | null,
) => {
  const ended = state === "not-checked" ? TIMED_OUT : { reason: null, detail: null };
  return {
    type: "claimCheck",
    attrs: {
      id,
      request: "check-1",
      action: "check-against-documents",
      state,
      text,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      ...ended,
      providerId: "anthropic",
      modelId: "claude-haiku-5-5",
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: CHECKED_AT,
      parts: [
        {
          span: { start: 0, end: text.length },
          kind: "fact",
          verdict: state,
          evidence: [],
          says: null,
          unsupported: null,
          calculation: null,
          ...ended,
          versions: [],
          excluded: [],
          citedCaseUnchecked: false,
          citedCaseFound: false,
          ...(leaning && { firstReading: { verdict: leaning, ...DECISION_MODEL } }),
        },
      ],
    },
  };
};

const colourOf = (mark: Locator) =>
  mark.evaluate((element) => {
    const style = getComputedStyle(element);
    const meta = getComputedStyle(document.documentElement).getPropertyValue("--color-ink-meta");
    const probe = document.createElement("span");
    probe.style.color = meta;
    element.append(probe);
    const ink = getComputedStyle(probe).color;
    probe.remove();
    return { colour: style.color, ink, wash: style.backgroundColor, shadow: style.boxShadow };
  });

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: MessageKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  test(`a first reading shows as a dashed grey ring and is named as one, never as a verdict (${language})`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await chooseScriptedModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    const write = (read: boolean) =>
      editor.evaluate(
        (dom, content) => {
          (dom as unknown as { editor: Editor }).editor.commands.setContent(content);
        },
        {
          type: "doc",
          content: (
            [
              ["likely", "checking", "supported"],
              ["against", "checking", "contradicted"],
              ["unconfirmed", "not-checked", "supported"],
              ["plain", "not-checked", null],
            ] as const
          ).map(([id, state, leaning]) => ({
            type: "paragraph",
            content: [
              {
                type: "text",
                text: words[id],
                marks: [unsettled(id, words[id], state, read ? leaning : null)],
              },
            ],
          })),
        },
      );
    if (SCREENSHOTS) {
      // The same sentences with no decision model reading: what the page showed before.
      await write(false);
      await screenshot(window, `first-reading-before-page-${language}`);
    }
    await write(true);
    const mark = (id: string) => window.locator(`[data-testid="claim-mark"][data-claim="${id}"]`);
    const card = window.getByTestId("claim-card");
    const names = { decision: "Decider v1.2", model: "Claude Haiku 5.5" };
    const likely = {
      supported: t("claim.state.likely.supported"),
      contradicted: t("claim.state.likely.contradicted"),
    };

    const onThePage = async () => {
      for (const [id, leaning] of [
        ["likely", "supported"],
        ["against", "contradicted"],
        ["unconfirmed", "supported"],
      ] as const) {
        const each = mark(id);
        await expect(each).toBeVisible();
        await expect(each).toHaveAttribute("data-leaning", leaning);
        await expect(each).toHaveAccessibleName(t("claim.mark.label", { state: likely[leaning] }));
        await expect(each.locator("circle[stroke-dasharray]")).toHaveCount(1);
        await expect(each).not.toHaveAttribute("data-addable", "true");
        // The meta ink, with no wash and no outline: nothing of a verdict's colour.
        const drawn = await colourOf(each);
        expect(drawn.colour).toBe(drawn.ink);
        expect(drawn.wash).toBe("rgba(0, 0, 0, 0)");
        expect(drawn.shadow).toBe("none");
        // The ring is the whole mark and stays inside its 18px.
        const ring = await each.locator("svg").boundingBox();
        const box = await each.boundingBox();
        if (!ring || !box) throw new Error("The mark isn't laid out.");
        expect(ring.width).toBeGreaterThanOrEqual(15);
        expect(ring.height).toBeLessThanOrEqual(box.height);
        expect(
          await each.locator("svg").evaluate((icon) => getComputedStyle(icon).animationName),
        ).toBe("none");
      }
      // A sentence whose check gave nothing keeps the solid grey ring, never the dashed one (#3358).
      await expect(mark("plain")).toBeVisible();
      await expect(mark("plain").locator("circle")).toHaveCount(1);
      await expect(mark("plain").locator("circle[stroke-dasharray]")).toHaveCount(0);
    };

    const open = async (id: keyof typeof words) => {
      await pointAndClick(window, mark(id));
      await expect(card).toBeVisible();
      await expect.poll(() => card.getAttribute("aria-label")).toContain(words[id]);
      await motionSettled(window);
    };
    const close = async () => {
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    };
    const inCard = async () => {
      // Checked still: the verdict line, the sentence, and whose reading and whose check.
      for (const [id, leaning] of [
        ["likely", "supported"],
        ["against", "contradicted"],
      ] as const) {
        await open(id);
        const badge = card.getByTestId("claim-badge");
        await expect(badge).toHaveText(likely[leaning]);
        await expect(badge.locator("circle[stroke-dasharray]")).toHaveCount(1);
        await expect(card.getByTestId("claim-reason")).toHaveText(
          t("claim.firstReading.checking", names),
        );
        for (const absent of [
          "claim-quote",
          "claim-source",
          "claim-add-citation",
          "claim-correct",
          "claim-check-again",
        ])
          await expect(card.getByTestId(absent), absent).toHaveCount(0);
        await expect(card.locator(".claim-sign")).toHaveCount(0);
        await close();
      }
      // Left unconfirmed: the same ring, why the check ended, and Check again.
      await open("unconfirmed");
      await expect(card).toHaveAttribute("data-check", "not-checked");
      await expect(card.getByTestId("claim-badge")).toHaveText(likely.supported);
      await expect(card.getByTestId("claim-reason")).toHaveText(
        t("claim.firstReading.unconfirmed", {
          decision: names.decision,
          reason: t("claim.reason.timed-out", { detail: "60" }),
        }),
      );
      await expect(card.getByTestId("claim-check-again")).toBeVisible();
      await expect(card.locator(".claim-sign")).toHaveCount(0);
    };

    await onThePage();
    if (language === "en") await film(window, inCard);
    else await inCard();
    await close();

    // Nobody read it: its card is Not checked, with the solid ring.
    await pointAndClick(window, editor.locator(":scope > p").filter({ hasText: words.plain }));
    await window.keyboard.press("ControlOrMeta+Shift+KeyK");
    await expect(card).toHaveAttribute("data-check", "not-checked");
    const plainBadge = card.getByTestId("claim-badge");
    await expect(plainBadge).toHaveText(t("claim.state.not-checked"));
    await expect(plainBadge.locator("circle[stroke-dasharray]")).toHaveCount(0);
    await expect(card.getByTestId("claim-reason")).toHaveText(
      t("claim.reason.timed-out", { detail: "60" }),
    );
    for (const theme of ["light", "dark"] as const) {
      await window.emulateMedia({ colorScheme: theme });
      await screenshot(window, `first-reading-solid-ring-card-${language}-${theme}-full`);
    }
    await window.emulateMedia({ colorScheme: "light" });
    await close();

    // Under 760px the marks stand in the text, and say the same.
    await sizeMind(app, window, 700);
    await expect(mark("likely")).toHaveClass(/claim-mark--inline/);
    await onThePage();

    for (const [size, resize] of [
      ["full", () => setWindowSize(app, window, 1440, 900)],
      ["inline", () => sizeMind(app, window, 700)],
    ] as const) {
      await resize();
      for (const theme of ["light", "dark"] as const) {
        await window.emulateMedia({ colorScheme: theme });
        await onThePage();
        await screenshot(window, `first-reading-page-${language}-${theme}-${size}`);
        for (const id of ["likely", "against", "unconfirmed"] as const) {
          await open(id);
          await screenshot(window, `first-reading-card-${id}-${language}-${theme}-${size}`);
          await close();
        }
      }
      await window.emulateMedia({ colorScheme: "light" });
    }
    await app.close();
  });
}
