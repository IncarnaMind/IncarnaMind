/**
 * The check badge stands with the Note's own controls at its top right (#3677): a Citation's
 * card, a footnote's card and the format menu opened near it leave it uncovered, at 900 and
 * 1440 px, in English and Chinese, with the conversation closed and open as a column, and
 * pressing it opens the checks. Each card is opened where, hanging from its anchor, it would reach
 * the badge's row. At 900 px the open conversation rises from the input's box at the Note's foot:
 * the badge opens the checks, and Show conversation folds it. Every press lands
 * where its target stands: with a Citation on every line, a pointer sliding across the Note rests
 * on some on the way, and the card one opens would take the press. Test data only: Kestrel Bay.
 */
import { randomUUID } from "node:crypto";
import { chmod, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  blocksUpdate,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  mindNode,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

const PHRASES = [
  "The early ferry from Kestrel Bay runs late",
  "and the quay fills with commuters",
  "who miss the 08:15 train",
  "while the café runs out of seats",
  "and the harbour plan waits for a second ramp",
];

const citation = () =>
  mindNode("citation", {
    passageId: "passage-ferry",
    documentId: "document-ferry",
    documentName: "Kestrel Bay ferry survey",
    contentHash: "hash-ferry",
    pageFrom: 1,
    pageTo: 1,
    quote: "The early crossing ran late on 41 of 60 weekdays.",
    check: "found",
  });

const footnote = () =>
  mindNode("footnote", { id: randomUUID() }, ["Counted by the harbour master in March."]);

/** How each paragraph starts, so its Citations stand at other places along its lines. */
const LEADS = ["", "On Monday ", "Again on Tuesday ", "By Wednesday ", "On Thursday, as before, "];

/** A paragraph with a Citation or a footnote after every phrase, so one stands on every line. */
const paragraph = (_: unknown, at: number) =>
  mindNode(
    "paragraph",
    { id: randomUUID() },
    PHRASES.flatMap((words, index) => [
      // Every other paragraph starts short, so a Citation stands at the start of a line too.
      `${index === 0 ? (at % 2 ? "Late again" : `${LEADS[at % LEADS.length]}${words}`) : words} `,
      index % 2 ? footnote() : citation(),
      " ",
    ]),
  );

type Box = { x: number; y: number; width: number; height: number };

const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

let dataDir: string;
let home: string;
let bin: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});
test.afterEach(async () => {
  for (const folder of [dataDir, home, bin]) await removeDataFolder(folder);
});

async function write(window: Page): Promise<void> {
  const update = Array.from(blocksUpdate(Array.from({ length: 24 }, paragraph)));
  await window.evaluate(async (bytes) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [mind] = await core.listMinds();
    if (!mind) throw new Error("There is no Note.");
    await core.applyMindUpdate(mind.id, new Uint8Array(bytes));
  }, update);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("It isn't on screen.");
  return box;
}

/**
 * Of `anchors` in the middle of the Note, so it can be scrolled to any height, the one a card
 * hanging from it would reach the badge from: `reach` left of the badge's left edge; with `under`,
 * the one closest under the badge's middle.
 */
async function anchorNear(anchors: Locator, badge: Box, reach: number, under = false) {
  const index = await anchors.evaluateAll(
    (elements, { badge, reach, under }) => {
      let best = -1;
      let score = Number.POSITIVE_INFINITY;
      elements.forEach((element, at) => {
        if (at < elements.length / 4 || at > (elements.length * 3) / 4) return;
        const box = element.getBoundingClientRect();
        const middle = box.left + box.width / 2;
        const off = under
          ? Math.abs(middle - (badge.x + badge.width / 2))
          : Math.abs(middle - (badge.x - reach));
        if (box.width > 0 && off < score) {
          score = off;
          best = at;
        }
      });
      return best;
    },
    { badge, reach, under },
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return anchors.nth(index);
}

/** Scrolls the Note so `anchor`'s top is at `top` in the window. */
async function scrollTo(scroller: Locator, anchor: Locator, top: number): Promise<void> {
  const now = (await boxOf(anchor)).y;
  await scroller.evaluate((element, by) => {
    element.scrollTop += by;
  }, now - top);
  await motionSettled(scroller.page());
  expect(Math.abs((await boxOf(anchor)).y - top)).toBeLessThan(2);
}

/** Where the Note's text the User can reach ends: above its input's box or the conversation over it. */
function roomBottom(group: Locator): Promise<number> {
  return group.evaluate((element) => {
    const scroller = element.querySelector('[data-testid="mind-scroller"]');
    const bottoms = [scroller?.getBoundingClientRect().bottom ?? window.innerHeight];
    // With the conversation open, the input is in it, beside the Note's text or over its right.
    const box = element
      .querySelector('[data-testid="note-ask-box"]:not([data-testid="note-column"] *)')
      ?.getBoundingClientRect();
    if (box && box.height > 0) bottoms.push(box.top);
    return Math.min(...bottoms);
  });
}

/**
 * Opens `card` from `anchor`, again when the first try opened nothing. A Citation's card comes with
 * the pointer resting on it, as a person reads one: pressed, a Citation in a wide window opens
 * what it cites beside the Note.
 */
async function openFrom(window: Page, anchor: Locator, cardId: string): Promise<void> {
  const card = window.getByTestId(cardId);
  await expect(async () => {
    if ((await card.count()) === 0) {
      if (cardId === "citation-card") {
        await window.mouse.move(0, 0);
        await anchor.hover();
      } else {
        await anchor.click();
      }
    }
    await expect(card).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Opens `card` from `anchor` where, hanging above it, its top would come 10 px into the badge's
 * row; or as high as the room in the Note lets it, which is said.
 */
async function openNear(
  window: Page,
  group: Locator,
  anchor: Locator,
  cardId: string,
  badge: Box,
): Promise<void> {
  const card = window.getByTestId(cardId);
  const scroller = group.getByTestId("mind-scroller");
  const bottom = await roomBottom(group);
  const below = badge.y + badge.height;
  await scrollTo(scroller, anchor, Math.min(below + 140, bottom - 60));
  await openFrom(window, anchor, cardId);
  const { height } = await boxOf(card);
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  const reach = below - 10 + 4 + height;
  const at = Math.min(reach, bottom - (await boxOf(anchor)).height - 4);
  if (at < reach) {
    test.info().annotations.push({
      type: "out of the badge's reach",
      description: `a card ${Math.round(height)} px tall can't reach the badge's row: the Note's text ends at ${Math.round(bottom)}`,
    });
  }
  await scrollTo(scroller, anchor, at);
  await openFrom(window, anchor, cardId);
  await motionSettled(window);
}

/** The badge is drawn on top where it stands, and pressing it opens the checks. */
async function pressable(window: Page, badge: Locator, card: Locator | null): Promise<void> {
  if (card) {
    const [badgeBox, cardBox] = [await boxOf(badge), await boxOf(card)];
    expect(apart(badgeBox, cardBox), "the card covers the badge").toBe(true);
  }
  expect(
    await badge.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top !== null && element.contains(top);
    }),
  ).toBe(true);
  await badge.click();
  const checks = window.getByTestId("check-card");
  await expect(checks).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(checks).toHaveCount(0);
  if (card) await expect(card).toHaveCount(0);
}

/**
 * The conversation open or closed: Show conversation opens it upward in the input's box, and Move
 * to the left moves it into the column at the window's left, where the window has room for one.
 */
async function setColumn(window: Page, group: Locator, open: boolean): Promise<void> {
  const toggle = group.getByTestId("note-ask-conversation-toggle");
  const column = window.getByTestId("note-column");
  const move = group.getByTestId("conversation-move-left");
  if ((await toggle.getAttribute("aria-expanded")) !== String(open)) {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", String(open));
  if (open && (await column.count()) === 0 && (await move.count()) > 0) await move.click();
  await expect(column.or(group.getByTestId("note-ask-panel"))).toHaveCount(open ? 1 : 0);
  await motionSettled(window);
}

/** One question answered at the Note's foot, so it has a conversation to show. */
async function asked(window: Page, language: "en" | "zh-CN"): Promise<void> {
  const input = window
    .locator('[data-testid="tab-group"][data-focused]')
    .getByTestId("note-ask-input");
  await input.click();
  await window.keyboard.type(
    language === "en" ? "Why is the early ferry late?" : "早班渡轮为什么晚点？",
  );
  await window.keyboard.press("Enter");
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const [mind] = await core.listMinds();
          const turns = mind ? await core.noteConversation(mind.id) : [];
          return turns.at(-1)?.outcome ?? "";
        }),
      { timeout: 30_000 },
    )
    .toBe("landed");
}

async function still(window: Page, name: string): Promise<void> {
  await motionSettled(window);
  await window.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

async function cardsNearTheBadge(
  app: ElectronApplication,
  window: Page,
  language: "en" | "zh-CN",
): Promise<void> {
  const group = window.locator('[data-testid="tab-group"][data-focused]');
  const editor = group.getByTestId("mind-editor");
  const scroller = group.getByTestId("mind-scroller");
  const badge = group.getByTestId("check-badge-open");
  const chips = editor.getByTestId("citation-chip");
  const markers = editor.getByTestId("footnote-marker");
  for (const width of [900, 1440]) {
    for (const column of [false, true]) {
      await setWindowSize(app, window, width, 900);
      await setColumn(window, group, column);
      const place = `${language}, ${width} px, conversation ${column ? "open" : "closed"}`;
      await expect(badge).toBeVisible();
      const badgeBox = await boxOf(badge);
      // In a narrow window the conversation rises from the input's box at the Note's foot: the
      // badge opens the checks with it open, and Show conversation folds it.
      if (column) {
        if (width === 900) await still(window, `conversation-open-${language}-900`);
        await pressable(window, badge, null);
      }

      // A Citation's card and a footnote's card hang above their anchor: each is opened where its
      // top would come 10 px into the badge's row, from an anchor a little left of the badge.
      for (const [kind, anchors, cardId] of [
        ["Citation", chips, "citation-card"],
        ["footnote", markers, "footnote-popover"],
      ] as const) {
        const anchor = await anchorNear(anchors, badgeBox, 100);
        const card = window.getByTestId(cardId);
        await test.step(`${kind}'s card, ${place}`, () =>
          openNear(window, group, anchor, cardId, badgeBox));
        if (kind === "Citation" && width === 900 && !column) {
          await still(window, `citation-card-near-badge-${language}-900`);
        }
        await pressable(window, badge, card);
      }

      // The format menu, from words near the top right just under the Note's own controls.
      const chip = await anchorNear(chips, badgeBox, 60);
      await scrollTo(scroller, chip, badgeBox.y + badgeBox.height + 24);
      const word = await boxOf(chip);
      await window.mouse.dblclick(word.x - 24, word.y + word.height / 2);
      const selectionMenu = window.getByTestId("selection-menu");
      await expect(selectionMenu, `selection menu, ${place}`).toBeVisible();
      await selectionMenu.getByTestId("format-aa").click();
      const format = window.getByTestId("format-menu");
      await expect(format, `format menu, ${place}`).toBeVisible();
      await pressable(window, badge, format);
      await editor.focus();
      await focusSettled(window, editor);
      await window.keyboard.press("ArrowRight");
      await expect(selectionMenu).toBeHidden();

      // A Citation right under the badge: its card can't come left of the badge and still hang
      // over it. What it does is kept as a still.
      if (width === 900 && !column) {
        const under = await anchorNear(chips, badgeBox, 0, true);
        const card = window.getByTestId("citation-card");
        await openNear(window, group, under, "citation-card", badgeBox);
        await still(window, `citation-card-under-badge-${language}-900`);
        const [anchorBox, cardBox] = [await boxOf(under), await boxOf(card)];
        test.info().annotations.push({
          type: "under the badge",
          description: `${language}: Citation ${Math.round(anchorBox.x)} to ${Math.round(anchorBox.x + anchorBox.width)}, card ${Math.round(cardBox.x)} to ${Math.round(cardBox.x + cardBox.width)}, badge ${Math.round(badgeBox.x)} to ${Math.round(badgeBox.x + badgeBox.width)}`,
        });
        await pressable(window, badge, card);
      }

      // Folded by Show conversation, or already by a press in the Note, as one opened upward is.
      if (column) await setColumn(window, group, false);
    }
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Citation's card, a footnote's card and the format menu near the check badge leave it pressable (${language})`, async () => {
    test.setTimeout(240_000);
    // The Note's input, and with it Show conversation, comes with the User's own AI connected.
    await writeFile(join(bin, "mode"), "explain");
    const { app, window } = await launchApp(dataDir, {
      home,
      ownAi: join(bin, "claude"),
      extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
    });
    await acceptPlainTextKeys(window);
    try {
      await dismissChatSetup(window);
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.setAgentsEnabled(true);
        await bridge.connectAgent({
          name: "Claude Code",
          client: "claude-code",
          folderIds: ["all"],
          propose: true,
        });
      });
      await setLanguage(window, language);
      await setWindowSize(app, window, 900, 900);
      await newMind(window);
      await write(window);
      await expect(
        window.locator('[data-testid="tab-group"][data-focused]').getByTestId("citation-chip"),
      ).toHaveCount(24 * 3);
      await asked(window, language);
      await cardsNearTheBadge(app, window, language);
    } finally {
      await app.close();
    }
  });
}
