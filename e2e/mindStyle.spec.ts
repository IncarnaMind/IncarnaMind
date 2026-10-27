import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  fontsDrawing,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  tabMenu,
} from "./app";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await target.screenshot({ path: join(folder, `${name}.png`) });
}

const WORDS = {
  en: {
    fontChanged: (font: string) => `Font changed to ${font}`,
    sizeChanged: (size: string) => `Text size changed to ${size}`,
    serif: "Serif",
    large: "Large",
    defaultSet: "New notes will start in this style",
    missing: "Not installed on this computer",
    style: "Style",
  },
  "zh-CN": {
    fontChanged: (font: string) => `字体已改为“${font}”`,
    sizeChanged: (size: string) => `字号已改为“${size}”`,
    serif: "衬线",
    large: "大",
    defaultSet: "新建的笔记将使用此样式",
    missing: "此电脑未安装该字体",
    style: "样式",
  },
} as const;

const WINDOW_HEIGHT = 700;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** Opens Style from the Mind's tab menu, as a person does, and waits for it to settle. */
async function openStyle(window: Page): Promise<Locator> {
  const menu = await tabMenu(window);
  await pointAndClick(window, menu.getByTestId("mind.style"));
  const panel = window.getByTestId("mind-style");
  await expect(panel).toBeVisible();
  await motionSettled(window);
  return panel;
}

const typeOf = (target: Locator) =>
  target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      family: style.fontFamily,
      size: Number.parseFloat(style.fontSize),
      leading: Number.parseFloat(style.lineHeight),
    };
  });

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A family name as the page's computed style writes it: quoted when it has a space. */
const startsWithFamily = (family: string) => new RegExp(`^"?${escaped(family)}"?,`);

for (const { language, width } of [
  { language: "en", width: 1600 },
  { language: "zh-CN", width: 1100 },
] as const) {
  const words = WORDS[language];

  test(`Style: a preset, an installed font and a text size, each at once and with Undo (${language}, ${width} px)`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, WINDOW_HEIGHT);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    const title = editor.locator("h1");
    await editor.click();
    await window.keyboard.type("# Tides");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Spring tides come at new moon");
    await window.keyboard.press("Enter");
    await window.keyboard.type("大潮在新月和满月时出现。");
    const paragraph = editor.locator("p").first();
    const line = '[data-testid="mind-editor"] p:nth-of-type(2)';

    // By default the Mind is in the system's font, 16 on 26.
    const standard = await typeOf(paragraph);
    expect(standard.family).not.toMatch(/Source Serif 4|JetBrains Mono/);
    expect(standard.size).toBe(16);
    expect(standard.leading).toBe(26);
    const sansChinese = (await fontsDrawing(window, line)).map((font) => font.family);

    // Style: Default, Serif and Mono side by side, each drawn in its own face, inside the window.
    const panel = await openStyle(window);
    await screenshot(window, `style-${language}-${width}`);
    const tiles = ["default", "serif", "mono"].map((id) =>
      panel.getByTestId(`mind-style-font-${id}`),
    );
    const boxes = await Promise.all(tiles.map((tile) => tile.boundingBox()));
    const [first, second, third] = boxes;
    if (!first || !second || !third) throw new Error("The presets aren't showing.");
    expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(second.y - third.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
    expect(first.x + first.width).toBeLessThanOrEqual(second.x);
    expect(second.x + second.width).toBeLessThanOrEqual(third.x);
    const panelBox = await panel.boundingBox();
    if (!panelBox) throw new Error("Style isn't showing.");
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(width);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(WINDOW_HEIGHT);
    for (const box of boxes) {
      if (!box) continue;
      expect(box.x).toBeGreaterThanOrEqual(panelBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
    }
    expect((await typeOf(tiles[1]?.locator("span").first() as Locator)).family).toMatch(
      /Source Serif 4/,
    );
    expect((await typeOf(tiles[2]?.locator("span").first() as Locator)).family).toMatch(
      /JetBrains Mono/,
    );
    await expect(tiles[0] as Locator).toHaveAttribute("aria-checked", "true");

    // Serif: the Mind and its heading change at once, 17 on 28, and Chinese takes a serif face too.
    await pointAndClick(window, tiles[1] as Locator);
    await expect.poll(() => typeOf(paragraph)).toMatchObject({ size: 17, leading: 28 });
    expect((await typeOf(paragraph)).family).toMatch(startsWithFamily("Source Serif 4"));
    expect((await typeOf(title)).family).toBe((await typeOf(paragraph)).family);
    expect((await fontsDrawing(window, line)).map((font) => font.family)).not.toEqual(sansChinese);
    await expect(tiles[1] as Locator).toHaveAttribute("aria-checked", "true");
    await expect(window.getByTestId("undo-line")).toContainText(words.fontChanged(words.serif));

    // Mono, then Undo puts Serif back, and the line says what it undid.
    await pointAndClick(window, tiles[2] as Locator);
    await expect
      .poll(async () => (await typeOf(paragraph)).family)
      .toMatch(startsWithFamily("JetBrains Mono"));
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect
      .poll(async () => (await typeOf(paragraph)).family)
      .toMatch(startsWithFamily("Source Serif 4"));

    // Text size: Large grows the text and its headings together, and Undo shrinks it.
    const panelAgain = await openStyle(window);
    const body = await typeOf(paragraph);
    const heading = await typeOf(title);
    await pointAndClick(window, panelAgain.getByTestId("mind-style-size-large"));
    await expect.poll(async () => (await typeOf(paragraph)).size).toBeGreaterThan(body.size);
    expect(await typeOf(paragraph)).toMatchObject({ size: 19, leading: 31 });
    expect((await typeOf(title)).size).toBeGreaterThan(heading.size);
    expect((await typeOf(paragraph)).leading).toBeGreaterThan(body.leading);
    await expect(window.getByTestId("undo-line")).toContainText(words.sizeChanged(words.large));
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect.poll(async () => (await typeOf(paragraph)).size).toBe(body.size);

    // Other fonts…: every installed family, each name in its own face, found by typing.
    const again = await openStyle(window);
    await pointAndClick(window, again.getByTestId("mind-style-other-fonts"));
    const picker = window.getByTestId("mind-style-font-picker");
    await expect(picker).toBeVisible();
    await motionSettled(window);
    const search = picker.getByTestId("mind-style-font-search");
    await expect(search).toBeFocused();
    const options = picker.getByTestId("mind-style-font-option");
    await expect(options.first()).toBeVisible();
    const families = await options.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-font") ?? ""),
    );
    expect(families.length).toBeGreaterThan(1);
    expect(new Set(families).size).toBe(families.length);
    const shown = await options
      .first()
      .locator("span")
      .last()
      .evaluate((name) => getComputedStyle(name).fontFamily);
    expect(shown).toMatch(startsWithFamily(families[0] ?? ""));
    await screenshot(window, `style-fonts-${language}-${width}`);
    const chosen =
      [
        "Georgia",
        "DejaVu Serif",
        "Liberation Serif",
        "Times New Roman",
        "DejaVu Sans",
        "Arial",
      ].find((family) => families.includes(family)) ??
      families[0] ??
      "";
    await window.keyboard.type(chosen.slice(0, 4));
    const found = await options.count();
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThanOrEqual(families.length);
    for (const name of await options.allTextContents()) {
      expect(name.toLocaleLowerCase()).toContain(chosen.slice(0, 4).toLocaleLowerCase());
    }
    await pointAndClick(window, picker.locator(`[data-font="${chosen}"]`));
    await expect(picker).toBeHidden();
    await expect
      .poll(async () => (await typeOf(paragraph)).family)
      .toMatch(startsWithFamily(chosen));
    expect((await typeOf(title)).family).toBe((await typeOf(paragraph)).family);
    await expect(window.getByTestId("undo-line")).toContainText(words.fontChanged(chosen));

    // Style shows the font as the Mind's own, installed, with no preset ticked.
    const withFont = await openStyle(window);
    const row = withFont.getByTestId("mind-style-font-other-chosen");
    await expect(row).toContainText(chosen);
    await expect(row).toHaveAttribute("data-installed", "true");
    await expect(withFont.getByText(words.missing)).toHaveCount(0);
    for (const tile of ["default", "serif", "mono"]) {
      await expect(withFont.getByTestId(`mind-style-font-${tile}`)).toHaveAttribute(
        "aria-checked",
        "false",
      );
    }
    await window.keyboard.press("Escape");
    await expect(withFont).toBeHidden();

    // It stays across a restart.
    const mindId = (await (await coreOf(window)).evaluate((core) => core.listMinds()))[0]?.id ?? "";
    await app.close();
    const reopened = await launchApp(dataDir);
    await reopened.window.getByTestId("mind-list-item").click();
    await expect
      .poll(
        async () =>
          (await typeOf(reopened.window.getByTestId("mind-editor").locator("p").first())).family,
      )
      .toMatch(startsWithFamily(chosen));
    expect(
      await (await coreOf(reopened.window)).evaluate((core, id) => core.getMindStyle(id), mindId),
    ).toEqual({ font: { family: chosen }, size: "default" });
    await reopened.app.close();
  });

  test(`Style: a font that isn't installed here is drawn in the default font, and Style says so (${language}, ${width} px)`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, WINDOW_HEIGHT);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("# Tides");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Spring tides come at new moon");
    const paragraph = editor.locator("p").first();
    const title = editor.locator("h1");
    const standard = await typeOf(paragraph);
    const mindId = (await (await coreOf(window)).evaluate((core) => core.listMinds()))[0]?.id ?? "";

    const missing = "Zzyzx Not Installed Here";
    await (await coreOf(window)).evaluate(
      (core, [id, family]) =>
        core.setMindStyle(id as string, { font: { family: family as string }, size: "default" }),
      [mindId, missing],
    );
    await expect.poll(() => typeOf(paragraph)).toEqual(standard);
    expect((await typeOf(title)).family).toBe(standard.family);

    const panel = await openStyle(window);
    const row = panel.getByTestId("mind-style-font-other-chosen");
    await expect(row).toContainText(missing);
    await expect(row).toContainText(words.missing);
    await expect(row).toHaveAttribute("data-installed", "false");
    await screenshot(window, `style-missing-${language}-${width}`);
    await app.close();
  });

  test(`Style: "make this the default for new Minds" starts each new Mind in the font and size, and Undo takes it back (${language}, ${width} px)`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, WINDOW_HEIGHT);
    const type = async () => typeOf(window.getByTestId("mind-editor").locator("p").first());
    const write = async (name: string) => {
      await newMind(window);
      await nameMind(window, name);
      await window.getByTestId("mind-editor").click();
      await window.keyboard.type(`${name} writes about the tides`);
      await expect(window.getByTestId("mind-editor").locator("p").first()).toContainText(name);
    };
    const settings = async () =>
      (await (await coreOf(window)).evaluate((core) => core.getSettings())).user.newMindStyle;
    const open = (name: string) =>
      pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: name }));

    await write("Alpha");
    const alpha = await type();
    await write("Beta");
    const panel = await openStyle(window);
    await pointAndClick(window, panel.getByTestId("mind-style-font-serif"));
    await pointAndClick(window, panel.getByTestId("mind-style-size-large"));
    await expect
      .poll(async () => (await type()).family)
      .toMatch(startsWithFamily("Source Serif 4"));
    const beta = await type();
    expect(beta.size).toBeGreaterThan(alpha.size);

    // Not yet the default for new Minds; the item is offered, in full, and closes Style.
    const make = panel.getByTestId("mind-style-make-default");
    await expect(make).not.toHaveAttribute("aria-disabled", "true");
    expect(
      await make.locator("span").evaluate((label) => label.scrollWidth <= label.clientWidth),
    ).toBe(true);
    await pointAndClick(window, make);
    await expect(panel).toBeHidden();
    await expect(window.getByTestId("undo-line")).toContainText(words.defaultSet);
    expect(await settings()).toEqual({ font: "serif", size: "large" });

    // Style now says so: the item is there but can't be used again.
    const after = await openStyle(window);
    await expect(after.getByTestId("mind-style-make-default")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await window.keyboard.press("Escape");

    // Undo takes it back: a new Mind starts in the default style again.
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect.poll(settings).toEqual({ font: "default", size: "default" });
    await write("Gamma");
    expect(await type()).toEqual(alpha);

    // Made the default again, a new Mind starts in it; the Minds made before keep their own.
    await open("Beta");
    const again = await openStyle(window);
    await pointAndClick(window, again.getByTestId("mind-style-make-default"));
    await expect.poll(settings).toEqual({ font: "serif", size: "large" });
    await write("Delta");
    expect(await type()).toEqual(beta);
    const deltaPanel = await openStyle(window);
    await expect(deltaPanel.getByTestId("mind-style-font-serif")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(deltaPanel.getByTestId("mind-style-size-large")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await screenshot(window, `style-default-${language}-${width}`);
    await window.keyboard.press("Escape");
    await open("Alpha");
    await expect.poll(type).toEqual(alpha);
    await open("Gamma");
    await expect.poll(type).toEqual(alpha);
    await app.close();
  });
}

for (const { language, listing } of [
  { language: "en", listing: "denied" },
  { language: "zh-CN", listing: "empty" },
  { language: "en", listing: "failing" },
] as const) {
  test(`Style with no installed fonts to list (${listing}, ${language}): Default, Serif and Mono stay, and nothing alarms`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, WINDOW_HEIGHT);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("Spring tides come at new moon");
    const paragraph = editor.locator("p").first();

    // Electron never asks: the page has the permission already.
    expect(
      await window.evaluate(
        async () =>
          (await navigator.permissions.query({ name: "local-fonts" as PermissionName })).state,
      ),
    ).toBe("granted");

    await window.evaluate((mode) => {
      const page = globalThis as unknown as Window;
      if (mode === "denied") {
        page.queryLocalFonts = () =>
          Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      } else if (mode === "failing") {
        page.queryLocalFonts = () => {
          throw new TypeError("The font list failed.");
        };
      } else {
        page.queryLocalFonts = () => Promise.resolve([]);
      }
    }, listing);

    const panel = await openStyle(window);
    for (const preset of ["default", "serif", "mono"]) {
      await expect(panel.getByTestId(`mind-style-font-${preset}`)).toBeVisible();
    }
    await pointAndClick(window, panel.getByTestId("mind-style-other-fonts"));
    const picker = window.getByTestId("mind-style-font-picker");
    await expect(picker).toBeVisible();
    await motionSettled(window);
    await expect(picker.getByTestId("mind-style-font-option")).toHaveCount(0);
    await expect(picker).toContainText(
      language === "en" ? "No other fonts found on this computer." : "此电脑上没有找到其他字体。",
    );
    await expect(picker.locator('[role="alert"]')).toHaveCount(0);
    await expect(window.getByTestId("error-notice")).toHaveCount(0);
    await screenshot(window, `style-no-fonts-${language}`);
    await window.keyboard.press("Escape");
    await expect(picker).toBeHidden();

    // The built-in fonts still work.
    const again = await openStyle(window);
    await pointAndClick(window, again.getByTestId("mind-style-font-mono"));
    await expect
      .poll(async () => (await typeOf(paragraph)).family)
      .toMatch(startsWithFamily("JetBrains Mono"));
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`⌘K reaches Style (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, WINDOW_HEIGHT);
    await newMind(window);
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(WORDS[language].style);
    const item = window.locator('[data-testid="palette"] [data-key="command:mind.style"]');
    await expect(item).toBeVisible();
    await pointAndClick(window, item);
    const panel = window.getByTestId("mind-style");
    await expect(panel).toBeVisible();
    await motionSettled(window);
    const box = await panel.boundingBox();
    if (!box) throw new Error("Style isn't showing.");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1100);
    expect(box.y + box.height).toBeLessThanOrEqual(WINDOW_HEIGHT);
    await window.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await app.close();
  });
}
