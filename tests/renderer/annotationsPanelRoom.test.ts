/**
 * The list beside a page (#327): it opens only where the page keeps the width
 * its toolbar needs, so ⋯ and Open externally stay at every width.
 */
import { expect, test } from "vitest";
import { BRIDGE_KEY } from "../../src/shared/bridge";

const noop = () => noop;
Object.defineProperty(globalThis, "window", {
  value: {
    [BRIDGE_KEY]: new Proxy({}, { get: () => noop }),
    localStorage: { getItem: () => null, setItem: () => undefined },
  },
  configurable: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: { languages: ["en"] },
  configurable: true,
});

test("the list opens only where the page keeps its width", async () => {
  const { useAnnotations } = await import("../../src/renderer/src/annotations");
  useAnnotations.setState({ panelOpen: false, room: true });

  useAnnotations.getState().setRoom(false);
  useAnnotations.getState().togglePanel(true);
  expect(useAnnotations.getState().panelOpen, "no room: it stays closed").toBe(false);

  useAnnotations.getState().setRoom(true);
  useAnnotations.getState().togglePanel(true);
  expect(useAnnotations.getState().panelOpen, "room: it opens").toBe(true);

  useAnnotations.getState().setRoom(false);
  useAnnotations.getState().togglePanel(true);
  expect(useAnnotations.getState().panelOpen, "the last room holds it closed").toBe(false);
});
