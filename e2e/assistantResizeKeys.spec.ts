import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setWindowSize,
  widthOf,
} from "./app";

/*
 * The assistant's resize line moved by keys on a slow computer: the core's word on an
 * earlier press reaches the window after later presses are shown, and must not put the line back.
 * The window runs four times slower, as a loaded laptop or CI's runner does.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

interface Holder {
  incarnamind: CoreBridge;
  rodWidths: number[];
  layoutEvents: number;
  watching?: boolean;
}

const startWatching = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as Holder;
    const rod = () => document.querySelector('[data-testid="assistant-resize"]');
    holder.rodWidths = [Number(rod()?.getAttribute("aria-valuenow"))];
    holder.layoutEvents = 0;
    if (holder.watching) return;
    holder.watching = true;
    new MutationObserver(() => {
      const width = Number(rod()?.getAttribute("aria-valuenow"));
      if (width !== holder.rodWidths.at(-1)) holder.rodWidths.push(width);
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-valuenow"],
    });
    holder.incarnamind.on("layout.changed", () => {
      holder.layoutEvents++;
    });
  });

const layoutEvents = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as Holder).layoutEvents);

const settled = (window: Page) =>
  window.evaluate(async () => {
    const holder = globalThis as unknown as Holder;
    await holder.incarnamind.getLayout("main");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return holder.rodWidths;
  });

const PRESSES = [
  { name: "pressed one by one", shift: false, held: false, presses: 20, step: 10 },
  { name: "pressed one by one with Shift", shift: true, held: false, presses: 8, step: 50 },
  { name: "held down", shift: false, held: true, presses: 20, step: 10 },
  { name: "held down with Shift", shift: true, held: true, presses: 8, step: 50 },
];

for (const { name, shift, held, presses, step } of PRESSES) {
  test(`the assistant's resize line moves by exactly what is pressed, wider with ← and narrower with →, keys ${name}, on a slow computer`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1600, 660);
    await newMind(window);
    const rod = window.getByTestId("assistant-resize");
    await expect(rod).toHaveAttribute("aria-valuenow", "320");
    const devtools = await window.context().newCDPSession(window);
    await devtools.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    for (const [key, direction] of [
      ["ArrowLeft", 1],
      ["ArrowRight", -1],
    ] as const) {
      await startWatching(window);
      const [start] = await settled(window);
      if (start === undefined) throw new Error("The resize line has no width.");
      await rod.focus();
      if (held) {
        if (shift) await window.keyboard.down("Shift");
        for (let press = 0; press < presses; press++) await window.keyboard.down(key);
        await window.keyboard.up(key);
        if (shift) await window.keyboard.up("Shift");
      } else {
        for (let press = 0; press < presses; press++) {
          await window.keyboard.press(shift ? `Shift+${key}` : key);
        }
      }
      await expect.poll(() => layoutEvents(window)).toBe(presses);
      const widths = await settled(window);

      const wanted = start + direction * presses * step;
      const ordered = [...widths].sort((a, b) => direction * (a - b));
      expect(widths, "the line never goes back a step").toEqual(ordered);
      expect(widths.at(-1)).toBe(wanted);
      expect(await widthOf(window.getByTestId("assistant"))).toBe(wanted);
      expect(
        await window.evaluate(async () => {
          const bridge = (globalThis as unknown as Holder).incarnamind;
          return (await bridge.getLayout("main")).assistant.width;
        }),
        "the core kept it",
      ).toBe(wanted);
    }
  });
}
