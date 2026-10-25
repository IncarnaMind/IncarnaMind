import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * The "Edit with AI…" field at the foot of the selection menu: what to change
 * is typed there, Enter asks for it as the assistant's composer would, and the
 * change applies in place. ⌘J puts the cursor in it and Esc takes it back to
 * the text, with the selection kept. The scripted model (src/main/fakeChat/
 * edit.ts) does what "replace X with Y" (把 X 换成 Y) says.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

/** The selection as the editor holds it, which the page's own drawing of it may lag behind. */
const selectedInMind = (editor: Locator) =>
  editor.evaluate((dom) => {
    const { state } = (dom as unknown as { editor: Editor }).editor;
    return state.doc.textBetween(state.selection.from, state.selection.to);
  });

async function mindWith(window: Page, text: string) {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(text);
  return { editor, note: editor.locator(":scope > p").first() };
}

interface Look {
  t: number;
  boxes: number[][];
  writing: number;
  working: number[] | null;
  running: number[] | null;
  applied: number[] | null;
}

/**
 * Looks at the page after every change to it, from now on: where each paragraph, the working
 * line, the running line and the Undo line are, and whether a Writing… line is drawn. A change
 * to the page is what a person would see differ, and unlike a frame callback it still comes when
 * the window isn't being painted, as on a busy runner. `enterAt` is when Enter was first pressed.
 */
async function watchPage(window: Page): Promise<void> {
  await window.evaluate(() => {
    const looks: Look[] = [];
    const state = { enterAt: 0, looks };
    (globalThis as unknown as { __watch: typeof state }).__watch = state;
    addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") state.enterAt = performance.now();
      },
      { capture: true, once: true },
    );
    const rect = (selector: string) => {
      const each = document.querySelector(selector);
      if (!each) return null;
      const box = each.getBoundingClientRect();
      return [box.left, box.top, box.width, box.height];
    };
    const look = () => {
      looks.push({
        t: performance.now(),
        boxes: [...document.querySelectorAll('[data-testid="mind-editor"] > p')].map((each) => {
          const box = each.getBoundingClientRect();
          return [box.top, box.height];
        }),
        writing: document.querySelectorAll('[data-testid="mind-writing"]').length,
        working: rect('[data-testid="selection-edit-working"]'),
        running: rect('[data-testid="menu-edit-line"]'),
        applied: rect('[data-testid="applied-line"]'),
      });
    };
    look();
    new MutationObserver(look).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  });
}

async function watched(window: Page): Promise<{ enterAt: number; looks: Look[] }> {
  return window.evaluate(
    () => (globalThis as unknown as { __watch: { enterAt: number; looks: Look[] } }).__watch,
  );
}

interface PlaceLook {
  texts: number[][];
  problem: number[] | null;
  running: number[] | null;
  applied: number[] | null;
}

/**
 * Where the text below the line is, and which line is drawn, from now on: after
 * every change to the page and on every frame painted, so a jump that lasts
 * between two changes is seen as well as one a change made.
 */
async function watchPlaces(window: Page): Promise<void> {
  await window.evaluate(() => {
    const looks: PlaceLook[] = [];
    const state = { watching: true, looks };
    (globalThis as unknown as { __places: typeof state }).__places = state;
    const rect = (selector: string) => {
      const each = document.querySelector(selector);
      if (!each) return null;
      const box = each.getBoundingClientRect();
      return [box.left, box.top, box.width, box.height];
    };
    const look = () => {
      looks.push({
        texts: [...document.querySelectorAll('[data-testid="mind-editor"] > p')].map((each) => {
          const box = each.getBoundingClientRect();
          return [box.top, box.height];
        }),
        problem: rect('[data-testid="edit-problem"]'),
        running: rect('[data-testid="menu-edit-line"]'),
        applied: rect('[data-testid="applied-line"]'),
      });
    };
    look();
    new MutationObserver(look).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const frame = () => {
      if (!state.watching) return;
      look();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

async function placesSeen(window: Page): Promise<PlaceLook[]> {
  return window.evaluate(() => {
    const state = (
      globalThis as unknown as {
        __places: { watching: boolean; looks: PlaceLook[] };
      }
    ).__places;
    state.watching = false;
    return state.looks;
  });
}

test("typing in the menu's Edit with AI field and pressing Enter changes the text in place, in English and in Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1280, 820);
  const { editor, note } = await mindWith(
    window,
    "The tides here are very strong and really regular.",
  );
  const menu = window.getByTestId("selection-menu");
  const field = menu.getByTestId("selection-edit-field");
  const line = editor.getByTestId("applied-line");

  // At the foot of the menu, under its AI rows.
  await slideSelect(window, note, "The tides here are very strong");
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", "Edit with AI…");
  const explain = await menu.getByTestId("selection-action-explain").boundingBox();
  const typed = await field.boundingBox();
  const frame = await menu.boundingBox();
  if (!explain || !typed || !frame) throw new Error("The menu isn't visible.");
  expect(typed.y).toBeGreaterThan(explain.y + explain.height - 1);
  expect(typed.y + typed.height).toBeLessThanOrEqual(frame.y + frame.height + 1);

  // Typed by mouse and keyboard; Enter applies it at once, with the cursor still in the text.
  await pointAndClick(window, field);
  await expect(field).toBeFocused();
  await window.keyboard.type("replace tides with waves");
  await window.keyboard.press("Enter");
  await expect(note).toHaveText("The waves here are very strong and really regular.");
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 1 paragraph");
  await expect(line.getByTestId("applied-undo")).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(window.getByTestId("composer-edit-quote")).toHaveCount(0);

  // ⌘Z takes it back.
  await window.keyboard.press("ControlOrMeta+z");
  await expect(note).toHaveText("The tides here are very strong and really regular.");
  await expect(line).toHaveCount(0);

  // In Chinese.
  await setLanguage(window, "zh-CN");
  await slideSelect(window, note, "The tides here");
  await expect(field).toHaveAttribute("placeholder", "用 AI 编辑…");
  await expect(menu.getByTestId("selection-edit-handoff")).toHaveAccessibleName("在助手中继续");
  await pointAndClick(window, field);
  await window.keyboard.type("把 tides 换成 seas");
  await window.keyboard.press("Enter");
  await expect(note).toHaveText("The seas here are very strong and really regular.");
  await expect(line.getByTestId("applied-count")).toHaveText("修改了 1 个段落");
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeFocused();
  await app.close();
});

test("while the AI works the menu is one line under the text, Enter does nothing, and Esc or Stop stops it with the text as it was", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1280, 820);
  const original = "The tides here are very strong and really regular.";
  const { editor, note } = await mindWith(window, original);
  const menu = window.getByTestId("selection-menu");
  const working = window.getByTestId("selection-edit-working");
  const ask = async () => {
    await slideSelect(window, note, "The tides here are very strong");
    await window.keyboard.press("ControlOrMeta+j");
    await expect(menu.getByTestId("selection-edit-field")).toBeFocused();
    // Asked "slowly", the scripted model takes a few seconds.
    await window.keyboard.type("Shorten this slowly");
    await window.keyboard.press("Enter");
    await expect(working).toBeVisible();
  };

  await ask();
  await expect(working).toContainText("Making the changes…");
  await expect(menu).toBeHidden();
  await expect(window.locator(".selection-working")).toBeFocused();
  const under = await working.boundingBox();
  const line = await note.boundingBox();
  if (!under || !line) throw new Error("The line isn't visible.");
  expect(under.y).toBeGreaterThanOrEqual(line.y + line.height - 2);

  // Enter twice more: neither splits the paragraph, and neither asks again.
  await window.keyboard.press("Enter");
  await window.keyboard.press("Enter");
  await expect(editor.locator(":scope > p")).toHaveCount(1);
  await expect(working).toBeVisible();

  // Esc stops it: the line goes with the AI's work, the text is as it was, the cursor is in it.
  await window.keyboard.press("Escape");
  await expect(working).toHaveCount(0);
  await expect(window.getByTestId("edit-pending")).toHaveCount(0);
  await expect(note).toHaveText(original);
  await expect(editor).toBeFocused();

  // Stop with the mouse does the same.
  await ask();
  await pointAndClick(window, working.getByTestId("selection-edit-stop"));
  await expect(working).toHaveCount(0);
  await expect(note).toHaveText(original);
  await expect(editor).toBeFocused();
  await expect(editor.getByTestId("applied-line")).toHaveCount(0);
  await app.close();
});

test("an edit from the menu shows no Writing… line, and nothing around the text moves while it streams in", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1280, 820);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  const lines = [
    "Spring tides are strongest at new moon.",
    "The tides here are very strong and really regular.",
    "The moon is really bright over the harbour tonight.",
    "The harbour is busy in spring.",
  ];
  for (const [index, line] of lines.entries()) {
    await window.keyboard.type(line);
    if (index < lines.length - 1) await window.keyboard.press("Enter");
  }
  const paragraphs = editor.locator(":scope > p");
  await slideSelect(window, paragraphs.nth(1), "The tides here", {
    line: paragraphs.nth(2),
    words: "bright over the harbour tonight.",
  });
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Shorten this slowly");

  await watchPage(window);
  await window.keyboard.press("Enter");
  await expect(editor.getByTestId("applied-line")).toBeVisible({ timeout: 40_000 });
  const { looks } = await watched(window);
  const streaming = looks.filter((each) => each.applied === null);
  const first = streaming[0];
  if (!first) throw new Error("Nothing was looked at before the change applied.");
  expect(streaming.some((each) => each.working !== null)).toBe(true);
  for (const each of streaming) {
    expect(each.writing).toBe(0);
    expect(each.boxes).toEqual(first.boxes);
    const [top = 0, height = 0] = each.boxes[2] ?? [];
    if (each.working !== null) expect(each.working[1]).toBeGreaterThanOrEqual(top + height - 1);
  }
  // The working line doesn't slide sideways as the words come in.
  const lefts = new Set(
    streaming.flatMap((each) => (each.working ? [Math.round(each.working[0] ?? 0)] : [])),
  );
  expect([...lefts]).toHaveLength(1);
  await expect(paragraphs.nth(1)).toHaveText("The tides here are strong and regular.");
  await expect(paragraphs.nth(2)).toHaveText("The moon is bright over the harbour tonight.");
  await app.close();
});

async function hideSidebar(window: Page) {
  const toggle = window.getByTestId("sidebar-toggle").first();
  await toggle.focus();
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

/** Whether any part of the element is inside the window and is what is drawn there. */
const onScreen = (target: Locator) =>
  target.evaluateAll((all) =>
    all.some((each) => {
      const box = each.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      const x = Math.min(Math.max(box.left + box.width / 2, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(box.top + box.height / 2, 0), window.innerHeight - 1);
      if (box.right <= 0 || box.left >= window.innerWidth) return false;
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (each.contains(hit) || hit.contains(each));
    }),
  );

for (const sidebar of ["shown", "hidden"] as const) {
  test(`once the menu is closed, a running menu edit reports in its Undo line's spot after 300 ms, and the Undo line replaces it in place, with the sidebar ${sidebar}`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setWindowSize(app, window, 1280, 820);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("The tides here are very strong and really regular.");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Notes:");
    const paragraphs = editor.locator(":scope > p");
    if (sidebar === "hidden") await hideSidebar(window);
    await editor.click();

    await slideSelect(window, paragraphs.first(), "The tides here are very strong");
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("Shorten this slowly");
    await expect(window.getByTestId("applied-line")).toHaveCount(0);
    await watchPage(window);
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("selection-edit-working")).toBeVisible();
    await pointAndClick(window, paragraphs.last());
    await expect(window.getByTestId("selection-edit-working")).toHaveCount(0);

    const running = editor.getByTestId("menu-edit-line");
    await expect(running).toBeVisible();
    await expect(running).toContainText("Making the changes…");
    expect(await onScreen(running)).toBe(true);
    expect(await onScreen(running.getByTestId("menu-edit-stop"))).toBe(true);
    await expect(window.getByTestId("edit-status")).toHaveCount(0);
    await expect(window.getByTestId("edit-pending")).toHaveCount(0);
    await expect(window.getByTestId("mind-writing")).toHaveCount(0);
    await expect(window.getByTestId("sidebar-toggle-dot")).toHaveCount(0);
    await expect(editor.getByTestId("applied-line")).toBeVisible({ timeout: 40_000 });

    const { enterAt, looks } = await watched(window);
    const shown = looks.filter((each) => each.running !== null);
    const first = shown[0];
    const last = shown.at(-1);
    const landed = looks.find((each) => each.applied !== null);
    if (!first || !last || !landed || enterAt === 0) {
      throw new Error(
        `The running or the Undo line was never seen: Enter at ${enterAt}, ${looks.length} looks, ${shown.length} with the running line, the first look ${JSON.stringify(looks[0])}, the last ${JSON.stringify(looks.at(-1))}.`,
      );
    }
    // Nothing shows for the first 300 ms of the request, which starts after Enter.
    expect(first.t - enterAt).toBeGreaterThanOrEqual(300);
    // The Undo line takes the running line's box, and nothing around it moves with the swap.
    expect(landed.applied).toEqual(last.running);
    expect(landed.boxes).toEqual(last.boxes);
    await app.close();
  });
}

for (const how of ["Stop on the running line", "Esc in the text"] as const) {
  test(`${how} stops a menu edit with the text as it was, with the sidebar hidden`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setWindowSize(app, window, 1280, 820);
    const original = "The tides here are very strong and really regular.";
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type(original);
    await window.keyboard.press("Enter");
    await window.keyboard.type("Notes:");
    const paragraphs = editor.locator(":scope > p");
    await hideSidebar(window);
    await editor.click();
    const running = editor.getByTestId("menu-edit-line");

    await slideSelect(window, paragraphs.first(), "The tides here are very strong");
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("Shorten this forever");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("selection-edit-working")).toBeVisible();
    await pointAndClick(window, paragraphs.last());
    await expect(running).toBeVisible();

    if (how === "Esc in the text") await window.keyboard.press("Escape");
    else await pointAndClick(window, running.getByTestId("menu-edit-stop"));
    await expect(running).toHaveCount(0);
    await expect(paragraphs.first()).toHaveText(original);
    await expect(editor.getByTestId("applied-line")).toHaveCount(0);
    await app.close();
  });
}

test("a second request while one runs can't send, and says why in the menu it was asked in", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1280, 820);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  const lines = [
    "The tides here are very strong and really regular.",
    "The moon is really bright over the harbour tonight.",
    "Harbours are very busy in the spring and really quiet in winter.",
    "Neap tides are weaker, and the water barely moves.",
  ];
  for (const [index, line] of lines.entries()) {
    await window.keyboard.type(line);
    if (index < lines.length - 1) await window.keyboard.press("Enter");
  }
  const paragraphs = editor.locator(":scope > p");
  const menu = window.getByTestId("selection-menu");
  const field = menu.getByTestId("selection-edit-field");

  // The first edit runs slowly over three paragraphs, its menu closed by a click on another one.
  await slideSelect(window, paragraphs.first(), "The tides", {
    line: paragraphs.nth(2),
    words: "quiet in winter.",
  });
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Shorten this slowly");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("selection-edit-working")).toBeVisible();
  await slideSelect(window, paragraphs.nth(3), "Neap tides are weaker");
  await expect(editor.getByTestId("menu-edit-line")).toHaveCount(1);

  // The second one is asked in the menu that opened over the other words.
  await window.keyboard.press("ControlOrMeta+j");
  await expect(field).toBeFocused();
  await window.keyboard.type("replace Neap with Low");
  await window.keyboard.press("Enter");
  const busy = window.getByTestId("edit-problem");
  await expect(busy).toHaveCount(1);
  await expect(busy).toContainText("Another edit is still running");
  await expect(menu.getByTestId("edit-problem")).toHaveCount(1);
  await expect(field).toHaveValue("replace Neap with Low");
  await expect(paragraphs.nth(3)).toHaveText(lines[3] ?? "");
  await expect(window.getByTestId("edit-pending")).toHaveCount(0);
  await app.close();
});

test("⌘J puts the cursor in the field; Esc takes it back to the text with the selection kept; ⌘J opens it again", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1280, 820);
  const { editor, note } = await mindWith(window, "Spring tides are strongest at new moon.");
  const menu = window.getByTestId("selection-menu");
  const field = menu.getByTestId("selection-edit-field");
  const select = async () => {
    await editor.click();
    await focusSettled(window, editor);
    await window.keyboard.press("End");
    for (let index = 0; index < "at new moon.".length; index++) {
      await window.keyboard.press("Shift+ArrowLeft");
    }
    await expect(menu).toBeVisible();
  };

  // The composer's chip keeps the selection drawn; with the chip left out, only the field does.
  await select();
  await pointAndClick(window, window.getByTestId("composer-selection-remove"));
  await expect(window.getByTestId("composer-selection")).toHaveCount(0);

  // Selected with the keyboard, the menu is under it: ⌘J goes into the field.
  await select();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(field).toBeFocused();
  await expect(note.locator(".held-selection")).toHaveText("at new moon.");
  await window.keyboard.type("shorter");
  await window.keyboard.press("ArrowLeft");
  await window.keyboard.press("Home");
  await expect(field).toBeFocused();

  // Esc: the menu closes, the cursor is in the text and the words are still selected.
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(await selectedInMind(editor)).toBe("at new moon.");

  // ⌘J with the menu closed opens it over the same words, with nothing typed.
  await window.keyboard.press("ControlOrMeta+j");
  await expect(menu).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  // Arrow keys move through the menu's rows from the field, and the rows lead back to it.
  await window.keyboard.press("ArrowUp");
  await expect(menu.getByTestId("selection-action-check-against-documents")).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(field).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  expect(await selectedInMind(editor)).toBe("at new moon.");
  await app.close();
});

test("Enter while an input method is composing doesn't send; the next Enter does", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1280, 820);
  const { editor, note } = await mindWith(window, "The tides here are very strong.");
  const field = window.getByTestId("selection-menu").getByTestId("selection-edit-field");

  await slideSelect(window, note, "The tides here are very strong");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(field).toBeFocused();
  const session = await window.context().newCDPSession(window);
  try {
    await session.send("Input.imeSetComposition", {
      text: "tihuan",
      selectionStart: 6,
      selectionEnd: 6,
    });
    // The Enter that picks a candidate, as Chromium reports it while composing, and as Safari-like engines do.
    await field.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await field.dispatchEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true });
    await session.send("Input.insertText", { text: "replace tides with seas" });
  } finally {
    await session.detach();
  }
  await expect(field).toHaveValue("replace tides with seas");
  await expect(note).toHaveText("The tides here are very strong.");
  await expect(window.getByTestId("selection-edit-working")).toHaveCount(0);
  await window.keyboard.press("Enter");
  await expect(note).toHaveText("The seas here are very strong.");
  await expect(editor.getByTestId("applied-count")).toHaveText("Changed 1 paragraph");
  await app.close();
});

test("the hand-off moves the typed request and the selection to the composer, which then asks it as an edit", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1280, 820);
  const { editor, note } = await mindWith(window, "The tides here are very strong.");
  const menu = window.getByTestId("selection-menu");
  const composer = window.getByTestId("composer");

  await slideSelect(window, note, "The tides here are very strong");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("replace tides with seas");
  await pointAndClick(window, menu.getByTestId("selection-edit-handoff"));

  await expect(menu).toHaveCount(0);
  const input = composer.getByTestId("composer-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("replace tides with seas");
  await expect(composer.getByTestId("composer-edit-quote")).toContainText(
    "Editing “The tides here are very strong",
  );
  await expect(note.locator(".proposal-target")).toHaveText("The tides here are very strong");
  await window.keyboard.press("Enter");
  await expect(note).toHaveText("The seas here are very strong.");
  await expect(editor.getByTestId("applied-count")).toHaveText("Changed 1 paragraph");
  await app.close();
});

test("a request that gives nothing shows its line in the menu, with the field and the selection kept", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1280, 820);
  const { editor, note } = await mindWith(window, "The tides here are very strong.");
  const menu = window.getByTestId("selection-menu");
  const field = menu.getByTestId("selection-edit-field");
  const problem = menu.getByTestId("edit-problem");

  await slideSelect(window, note, "The tides here are very strong");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("replace zebras with horses");
  await window.keyboard.press("Enter");

  await expect(problem).toContainText("Nothing to change");
  await expect(window.getByTestId("edit-problem")).toHaveCount(1);
  await expect(field).toHaveValue("replace zebras with horses");
  await expect(field).toBeFocused();
  await expect(note).toHaveText("The tides here are very strong.");
  expect(await selectedInMind(editor)).toBe("The tides here are very strong");

  // Changing the words and asking again works from the same field.
  await pointAndClick(window, problem.getByTestId("edit-problem-close"));
  await expect(problem).toHaveCount(0);
  await field.fill("replace tides with seas");
  await field.press("Enter");
  await expect(note).toHaveText("The seas here are very strong.");
  await expect(menu).toHaveCount(0);
  await app.close();
});

for (const sidebar of ["shown", "hidden"] as const) {
  test(`a failure shows once: in the menu while it is open, then in the Undo line's spot when it closes, where Try again works, with the sidebar ${sidebar}`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    // A model its provider doesn't know: every request to it fails.
    await useLocalChatModel(window, "fake-not-found");
    await setWindowSize(app, window, 1280, 820);
    const original = "The tides here are very strong.";
    const { editor, note } = await mindWith(window, original);
    if (sidebar === "hidden") await hideSidebar(window);
    await editor.click();
    const menu = window.getByTestId("selection-menu");
    const field = menu.getByTestId("selection-edit-field");
    const problem = window.getByTestId("edit-problem");

    await slideSelect(window, note, "The tides here are very strong");
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("replace tides with seas");
    await window.keyboard.press("Enter");
    await expect(problem).toHaveCount(1);
    await expect(menu.getByTestId("edit-problem")).toContainText(/Edit with AI didn.t work/);
    await expect(field).toHaveValue("replace tides with seas");

    // Try again from the menu asks again and fails again, still one line.
    await pointAndClick(window, menu.getByRole("button", { name: "Try again" }));
    await expect(menu.getByTestId("edit-problem")).toHaveCount(1);
    await expect(problem).toHaveCount(1);

    // Esc closes the menu: the line is now in the page, in plain words, in view, and nowhere else.
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(problem).toHaveCount(1);
    await expect(editor.getByTestId("edit-problem")).toContainText(/Edit with AI didn.t work/);
    expect(await onScreen(problem)).toBe(true);
    await expect(window.getByTestId("edit-status-problem")).toHaveCount(0);
    await expect(window.getByTestId("sidebar-toggle-dot")).toHaveCount(0);
    expect(await selectedInMind(editor)).toBe("The tides here are very strong");
    const spot = await problem.boundingBox();

    // With a model that answers, Try again changes the text in place, and the Undo line takes the spot.
    await useLocalChatModel(window);
    await pointAndClick(window, problem.getByTestId("menu-edit-action"));
    await expect(note).toHaveText("The seas here are very strong.");
    await expect(problem).toHaveCount(0);
    const undo = await editor.getByTestId("applied-line").boundingBox();
    expect(undo?.y).toBe(spot?.y);
    expect(undo?.height).toBe(spot?.height);
    await expect(editor.getByTestId("applied-count")).toHaveText("Changed 1 paragraph");
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Try again turns the problem line into the working line in its own box, so the text doesn't jump, in ${language}`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    // A model its provider doesn't know: the first request fails.
    await useLocalChatModel(window, "fake-not-found");
    await setWindowSize(app, window, 1280, 820);
    await setLanguage(window, language);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("The tides here are very strong.");
    await window.keyboard.press("Enter");
    await window.keyboard.type("The moon is bright over the harbour.");
    const paragraphs = editor.locator(":scope > p");
    const menu = window.getByTestId("selection-menu");
    const line = editor.getByTestId("edit-problem");

    await slideSelect(window, paragraphs.first(), "The tides here are very strong");
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("replace tides with seas slowly");
    await window.keyboard.press("Enter");
    await expect(menu.getByTestId("edit-problem")).toContainText(
      language === "en" ? /Edit with AI didn.t work/ : "用 AI 编辑未能完成",
    );
    // Esc closes the menu: the same line shows in the page, until Try again.
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(line).toContainText(language === "en" ? "Try again" : "重试");
    const spot = await line.boundingBox();
    if (!spot) throw new Error("The problem line isn't visible.");
    const before = await paragraphs.evaluateAll((all) =>
      all.map((each) => {
        const box = each.getBoundingClientRect();
        return [box.top, box.height];
      }),
    );

    // With a model that answers slowly, Try again runs at once, and nothing below the line moves.
    await useLocalChatModel(window);
    await watchPlaces(window);
    await pointAndClick(window, line.getByTestId("menu-edit-action"));
    const running = editor.getByTestId("menu-edit-line");
    await expect(running).toContainText(language === "en" ? "Making the changes…" : "正在修改…");
    await expect(editor.getByTestId("applied-line")).toBeVisible({ timeout: 40_000 });
    const places = await placesSeen(window);

    const beforeLine = places.filter((each) => each.applied === null);
    expect(beforeLine.length).toBeGreaterThan(0);
    for (const each of beforeLine) {
      // The line's box never goes away: the working line is drawn where the problem was.
      expect(each.problem ?? each.running).not.toBeNull();
      expect(each.texts).toEqual(before);
    }
    const working = beforeLine.filter((each) => each.running !== null);
    expect(working.length).toBeGreaterThan(0);
    for (const each of working)
      expect(each.running).toEqual([spot.x, spot.y, spot.width, spot.height]);
    // The Undo line replaces the working line in the same box, and the text still hasn't moved.
    const applied = places.find((each) => each.applied !== null);
    if (!applied) throw new Error("The Undo line was never seen.");
    expect(applied.texts).toEqual(before);
    await expect(paragraphs.first()).toHaveText("The seas here are very strong.");
    await app.close();
  });
}

test("Close on the failure line takes it away", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window, "fake-not-found");
  await setWindowSize(app, window, 1280, 820);
  const { editor, note } = await mindWith(window, "The tides here are very strong.");
  await slideSelect(window, note, "The tides here are very strong");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("replace tides with seas");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("edit-problem")).toHaveCount(1);
  await window.keyboard.press("Escape");
  const line = editor.getByTestId("edit-problem");
  await expect(line).toBeVisible();
  await pointAndClick(window, line.getByTestId("menu-edit-close"));
  await expect(window.getByTestId("edit-problem")).toHaveCount(0);
  await expect(note).toHaveText("The tides here are very strong.");
  await app.close();
});

test("with no model chosen, the field shows what the assistant would: the setup line", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1280, 820);
  const { note } = await mindWith(window, "The tides here are very strong.");
  const menu = window.getByTestId("selection-menu");

  await slideSelect(window, note, "The tides here are very strong");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("make it shorter");
  await window.keyboard.press("Enter");

  await expect(menu.getByTestId("edit-problem")).toBeVisible();
  await expect(menu.getByTestId("selection-edit-field")).toHaveValue("make it shorter");
  await expect(note).toHaveText("The tides here are very strong.");
  await app.close();
});

test("in a short window the menu fits the Mind's view, and the field stays in sight at its foot", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 900, 560);
  const { note } = await mindWith(window, "The tides here are very strong and really regular.");
  const menu = window.getByTestId("selection-menu");
  const field = menu.getByTestId("selection-edit-field");

  await slideSelect(window, note, "The tides here are very strong");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(field).toBeFocused();
  const view = await window.locator(".mind-scroller").boundingBox();
  const inMenu = await menu.boundingBox();
  const typed = await field.boundingBox();
  if (!view || !inMenu || !typed) throw new Error("The menu isn't visible.");
  expect(inMenu.height).toBeLessThanOrEqual(view.height);
  expect(typed.y).toBeGreaterThanOrEqual(view.y);
  expect(typed.y + typed.height).toBeLessThanOrEqual(view.y + view.height + 1);
  await app.close();
});

test("at 900 px the menu is over the page's bottom fade, and its field is not under it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 900, 780);
  const { note } = await mindWith(window, "The tides here are very strong and really regular.");
  const field = window.getByTestId("selection-menu").getByTestId("selection-edit-field");

  await slideSelect(window, note, "The tides here are very strong");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(field).toBeFocused();
  const layers = await window.evaluate(() => {
    const frame = document.querySelector(".selection-menu-frame");
    const foot = document.querySelector(".mind-foot-slot");
    const box = document.querySelector('[data-testid="selection-edit-field"]');
    if (!frame || !foot || !box) throw new Error("The menu or the page's foot isn't there.");
    return {
      frame: getComputedStyle(frame).zIndex,
      foot: getComputedStyle(foot).zIndex,
      // The fade is the foot's 100 px above its bottom edge.
      fadeTop: foot.getBoundingClientRect().bottom - 100,
      fieldBottom: box.getBoundingClientRect().bottom,
    };
  });
  expect(layers.fieldBottom).toBeGreaterThan(layers.fadeTop);
  expect(Number(layers.frame)).toBeGreaterThan(Number(layers.foot === "auto" ? 0 : layers.foot));
  await app.close();
});
