import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  askFirstQuestion,
  createDataFolder,
  interceptOpenExternal,
  launchApp,
  openSettings,
  openSetupSteps,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * Decision models offered before their key is saved (#2615, #1907): the sorting picker, on the
 * setup card and in Settings › Models, ends with "Set up another decision model", which holds
 * "Use TypeSafe Jev…" and each host with a key of its own. Choosing one opens its key entry in
 * place, with what choosing it sends. Nothing goes to the host before its Use this; a refused key
 * says so there and chooses nothing; a valid one makes it what sorts. One stand-in plays TypeSafe
 * and every other host here.
 */

const JEV_KEY = "jev-smoke-key";

/** A stand-in for TypeSafe's hosted Jev: it counts what reaches it and refuses any other key. */
async function startFakeTypeSafe() {
  const requests: string[] = [];
  const server: Server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push(request.headers.authorization ?? "");
    if (request.headers.authorization !== `Bearer ${JEV_KEY}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Invalid API key." }));
      return;
    }
    const { questions } = JSON.parse(text) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((id) => [id, { type: "noul", noul: 0.02 }]),
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "jev-1.14.0", answers, usage: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, requests };
}

let dataDir: string;
let typeSafe: Awaited<ReturnType<typeof startFakeTypeSafe>>;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  typeSafe = await startFakeTypeSafe();
});
test.afterEach(async () => {
  typeSafe.server.closeAllConnections();
  await new Promise((resolve) => typeSafe.server.close(resolve));
  await removeDataFolder(dataDir);
});

const library = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.getLibrary()).settings;
  });

/** The rows that set a decision model up, as the setup card and Settings list them with no key. */
const setUpRows = (language: "en" | "zh-CN") => [
  translate(language, "jev.settings.setUp"),
  translate(language, "decisions.setUp.row", { model: "Decider v1.2", provider: "Perplexity" }),
  translate(language, "decisions.setUp.row", { model: "d1-ultra", provider: "Liquid AI" }),
  translate(language, "decisions.setUp.row", {
    model: "Clef",
    provider: "Cloudflare Workers AI",
  }),
];

/** The picker's rows, in order. */
const rowsOf = (picker: Locator) =>
  picker.locator("option").evaluateAll((options) => options.map((each) => each.textContent));

/** Whether the element fits inside `container` sideways, as the layout holds at any width. */
async function fitsIn(element: Locator, container: Locator): Promise<boolean> {
  const [inner, outer] = await Promise.all([element.boundingBox(), container.boundingBox()]);
  if (!inner || !outer) throw new Error("Not on screen.");
  return inner.x >= outer.x - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5;
}

/** Whether the element's top, or all of it, shows inside the card, which scrolls in a short window. */
async function showsIn(element: Locator, card: Locator, whole: boolean): Promise<boolean> {
  const [inner, outer] = await Promise.all([element.boundingBox(), card.boundingBox()]);
  if (!inner || !outer) throw new Error("Not on screen.");
  const bottom = whole ? inner.y + inner.height : inner.y + 1;
  return inner.y >= outer.y - 0.5 && bottom <= outer.y + outer.height + 0.5;
}

async function launch(language: "en" | "zh-CN", width: number, height: number) {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    jev: typeSafe.url,
    decisions: typeSafe.url,
  });
  await setWindowSize(app, window, width, height);
  await acceptPlainTextKeys(window);
  await setLanguage(window, language);
  return { app, window };
}

/** The setup card's step 3, open with its list read. */
async function openSortingStep(window: Page): Promise<Locator> {
  const card = await askFirstQuestion(window);
  await setLocalChatModel(window);
  await openSetupSteps(window);
  await expect(card.getByTestId("setup-step-transcription")).toBeVisible({ timeout: 15_000 });
  await pointAndClick(window, card.getByTestId("setup-transcription-use"));
  await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });
  return card;
}

async function noTypeSafeRequestYet(app: ElectronApplication) {
  expect(typeSafe.requests).toEqual([]);
  expect(await urlsOpened(app)).toEqual([]);
}

for (const language of ["en", "zh-CN"] as const) {
  for (const [width, height] of [
    [900, 800],
    [1440, 900],
  ] as const) {
    test(`the setup card's sorting step sets Jev up in place: Cancel, a refused key, then a valid one (${language}, ${width} × ${height}) (#2615)`, async () => {
      const { app, window } = await launch(language, width, height);
      try {
        await interceptOpenExternal(app);
        const card = await openSortingStep(window);
        const picker = card.getByTestId("models-sorting");
        const chat = translate(language, "models.sorting.chat");
        const setUp = translate(language, "jev.settings.setUp");

        // After the choice that can run, folded under one group: Jev, then each host.
        await expect(picker.locator("option")).toHaveText([chat, ...setUpRows(language)]);
        await expect(picker.locator("optgroup")).toHaveAttribute(
          "label",
          translate(language, "decisions.setUp.group"),
        );
        await expect(picker.locator("option:checked")).toHaveText(chat);

        // Chosen, it opens the Jev key entry in place, with the field in hand, what Jev is, a
        // link to TypeSafe's prices and what choosing it sends; the step's own buttons give way.
        await picker.selectOption({ label: setUp });
        const setUpJev = card.getByTestId("jev-sorting-set-up");
        const form = setUpJev.getByTestId("jev-form");
        const field = form.getByLabel(translate(language, "jev.form.apiKey"));
        await expect(field).toBeFocused();
        await expect(setUpJev.getByTestId("jev-sorting-line")).toHaveText(
          `${translate(language, "jev.setUp.line")} · ${translate(language, "providers.form.pricing")} ↗`,
        );
        await expect(form.getByTestId("models-sorting-line")).toContainText(
          translate(language, "setup.sorting.sends", { service: "TypeSafe Jev" }),
        );
        await expect(form.getByTestId("models-sorting-line")).toContainText(
          translate(language, "setup.sorting.uses"),
        );
        await expect(
          form.getByRole("button", { name: translate(language, "providers.form.test") }),
        ).toHaveCount(0);
        await expect(card.getByTestId("setup-sorting-use")).toHaveCount(0);
        const use = form.getByTestId("jev-save");
        await expect(use).toHaveText(translate(language, "setup.step.useThis"));
        expect(await fitsIn(form, card)).toBe(true);
        expect(await fitsIn(use, card)).toBe(true);
        expect(await showsIn(field, card, true), "the key field shows").toBe(true);
        // Where the card has the room, the form's buttons show with the field.
        if (height >= 900) expect(await showsIn(use, card, true), "Use this shows").toBe(true);
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await noTypeSafeRequestYet(app);

        // Cancel puts the choice back as it was.
        await pointAndClick(
          window,
          form.getByRole("button", { name: translate(language, "providers.settings.cancel") }),
        );
        await expect(setUpJev).toHaveCount(0);
        await expect(picker.locator("option:checked")).toHaveText(chat);
        await expect(picker).toBeFocused();
        await expect(card.getByTestId("setup-sorting-use")).toBeVisible();

        // The link opens TypeSafe's own page; the app states no price.
        await picker.selectOption({ label: setUp });
        await pointAndClick(window, setUpJev.getByTestId("jev-pricing"));
        await expect.poll(() => urlsOpened(app)).toEqual(["https://docs.typesafe.ai/models"]);
        expect(typeSafe.requests).toEqual([]);

        // Typed, the key still goes nowhere until Use this. A refused key says so in place, and
        // nothing is chosen.
        await field.fill("jev-a-wrong-key");
        await expect(use).toBeEnabled();
        expect(typeSafe.requests).toEqual([]);
        await pointAndClick(window, use);
        await expect(form.getByTestId("connection-test")).toContainText(
          translate(language, "providers.test.auth"),
        );
        await expect
          .poll(() => showsIn(form.getByTestId("connection-test"), card, false))
          .toBe(true);
        expect(typeSafe.requests).toEqual(["Bearer jev-a-wrong-key"]);
        expect((await library(window)).classifier).toEqual({ kind: "automatic" });
        await expect(card.getByTestId("setup-step-sorting")).not.toHaveAttribute("data-done");

        // A valid key is saved and chosen, and the step is done with Jev.
        await field.fill(JEV_KEY);
        await pointAndClick(window, use);
        await expect(card).toHaveCount(0);
        await expect.poll(async () => (await library(window)).classifier).toEqual({ kind: "jev" });
        expect((await library(window)).automatic).toBe(true);
        expect(typeSafe.requests).toEqual(["Bearer jev-a-wrong-key", `Bearer ${JEV_KEY}`]);
      } finally {
        await app.close();
      }
    });
  }
}

for (const [language, width, height] of [
  ["en", 1440, 900],
  ["zh-CN", 900, 800],
] as const) {
  test(`Settings › Models offers Jev until its key is saved, then lists it first (${language}, ${width} × ${height}) (#2615)`, async () => {
    const { app, window } = await launch("en", width, height);
    try {
      await setLocalChatModel(window);
      // The button that opens Settings is named in English until the language is changed inside it.
      const settings = await openSettings(window, "models");
      await setLanguage(window, language);
      const row = settings.getByTestId("model-default-row-sorting");
      const picker = row.getByTestId("models-sorting");
      const setUp = translate(language, "jev.settings.setUp");
      await expect(picker.locator("optgroup option")).toHaveText(setUpRows(language));
      const before = await rowsOf(picker);
      expect(before.length).toBeGreaterThan(1);
      const chosen = await picker.locator("option:checked").textContent();

      await picker.selectOption({ label: setUp });
      const form = row.getByTestId("jev-form");
      const field = form.getByLabel(translate(language, "jev.form.apiKey"));
      await expect(field).toBeFocused();
      // Choosing here never turns tagging on: the line says what goes once it is on.
      await expect(form.getByTestId("models-sorting-line")).toContainText(
        translate(language, "setup.sorting.sendsWhenOn", { service: "TypeSafe Jev" }),
      );
      expect(await fitsIn(form, settings)).toBe(true);
      expect(typeSafe.requests).toEqual([]);

      // Esc is Cancel: the choice is as it was.
      await field.press("Escape");
      await expect(form).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(picker.locator("option:checked")).toHaveText(chosen ?? "");
      expect(await rowsOf(picker)).toEqual(before);

      await picker.selectOption({ label: setUp });
      await field.fill(JEV_KEY);
      await pointAndClick(window, form.getByTestId("jev-save"));
      await expect(form).toHaveCount(0);
      await expect(picker.locator("option:checked")).toHaveText("TypeSafe Jev");
      await expect(picker.locator("option").first()).toHaveText("TypeSafe Jev");
      await expect(picker.locator("option", { hasText: setUp })).toHaveCount(0);
      await expect(row.getByTestId("models-tagging-off")).toBeVisible();
      expect((await library(window)).classifier).toEqual({ kind: "jev" });
      expect(typeSafe.requests).toEqual([`Bearer ${JEV_KEY}`]);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › Models sets a host up in place: a refused key, then a valid one makes its best model what sorts and joins Your providers, and Remove key gives sorting back to Automatic (${language}) (#1907)`, async () => {
    const { app, window } = await launch("en", 900, 800);
    try {
      await setLocalChatModel(window);
      const settings = await openSettings(window, "models");
      await setLanguage(window, language);
      // No list of hosts: the sorting row chooses, and Your providers holds the keys.
      const providers = settings.getByTestId("your-providers");
      await expect(providers.getByTestId("provider-row")).toHaveCount(1);
      await expect(providers.getByTestId("sorting-key-row")).toHaveCount(0);
      await expect(settings.getByTestId("decision-hosts")).toHaveCount(0);
      const row = settings.getByTestId("model-default-row-sorting");
      const picker = row.getByTestId("models-sorting");
      const liquid = translate(language, "decisions.setUp.row", {
        model: "d1-ultra",
        provider: "Liquid AI",
      });
      // The list is read: its set-up rows show.
      await expect(picker.locator("optgroup option")).toHaveText(setUpRows(language));
      const chosen = await picker.locator("option:checked").textContent();

      await picker.selectOption({ label: liquid });
      const form = row.getByTestId("decision-key-form-liquid");
      const field = form.getByTestId("decision-key-input");
      await expect(field).toBeFocused();
      await expect(form.getByTestId("models-sorting-line")).toContainText(
        translate(language, "setup.sorting.sendsWhenOn", { service: "Liquid AI" }),
      );
      expect(await fitsIn(form, settings)).toBe(true);
      expect(typeSafe.requests).toEqual([]);

      // Esc is Cancel: the choice is as it was.
      await field.press("Escape");
      await expect(form).toHaveCount(0);
      await expect(picker.locator("option:checked")).toHaveText(chosen ?? "");

      await picker.selectOption({ label: liquid });
      await field.fill("a-wrong-key");
      await pointAndClick(window, form.getByTestId("decision-key-save"));
      await expect(form.getByTestId("decision-key-problem")).toContainText(
        translate(language, "error.decision.keyRefused", {
          provider: "Liquid AI",
          message: "Invalid API key.",
        }),
      );
      expect((await library(window)).classifier).toEqual({ kind: "automatic" });

      await field.fill(JEV_KEY);
      await pointAndClick(window, form.getByTestId("decision-key-save"));
      await expect(form).toHaveCount(0);
      await expect(picker.locator("option:checked")).toHaveText("d1-ultra · Liquid AI");
      await expect(picker.locator("option", { hasText: liquid })).toHaveCount(0);
      // As for Jev, choosing here never turns tagging on: Turn on… does, with its line.
      await expect(row.getByTestId("models-tagging-off")).toBeVisible();
      const liquidKey = providers.locator('[data-testid="sorting-key-row"][data-host="liquid"]');
      await expect(liquidKey).toContainText("Liquid AI");
      await expect(liquidKey).toContainText(translate(language, "models.providers.forSorting"));
      expect((await library(window)).classifier).toEqual({
        kind: "decision",
        host: "liquid",
        modelId: "d1-ultra",
      });
      expect(typeSafe.requests).toEqual(["Bearer a-wrong-key", `Bearer ${JEV_KEY}`]);

      // Change key opens its form in place; Esc puts it away.
      await pointAndClick(window, liquidKey.getByTestId("sorting-key-change"));
      const keyField = liquidKey.getByTestId("decision-key-input");
      await expect(keyField).toBeFocused();
      await keyField.press("Escape");
      await expect(liquidKey.getByTestId("decision-key-form-liquid")).toHaveCount(0);

      // Remove key: sorting goes back to Automatic's pick, and the host is offered again.
      await pointAndClick(window, liquidKey.getByTestId("sorting-key-remove"));
      await expect(liquidKey).toHaveCount(0);
      await expect(picker.locator("option:checked")).toHaveText(chosen ?? "");
      await expect(picker.locator("optgroup option", { hasText: liquid })).toHaveCount(1);
      expect((await library(window)).classifier).toEqual({ kind: "automatic" });
      expect(typeSafe.requests).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
}
