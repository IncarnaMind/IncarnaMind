/**
 * The list beside a page (#327): it opens only in a viewer with room for it, by
 * that viewer's own width, and two viewers never share an open list.
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

test("each viewer's list is its own, and opens only where that viewer has room", async () => {
  const { useAnnotations } = await import("../../src/renderer/src/annotations");
  useAnnotations.setState({ panelOpen: {}, listInPlace: {}, room: {} });

  useAnnotations.getState().setRoom("narrow", false);
  useAnnotations.getState().setRoom("wide", true);
  useAnnotations.getState().togglePanel(true, "narrow");
  expect(useAnnotations.getState().panelOpen.narrow, "no room: it stays closed").toBe(false);

  useAnnotations.getState().togglePanel(true, "wide");
  expect(useAnnotations.getState().panelOpen.wide, "room: it opens").toBe(true);
  expect(useAnnotations.getState().panelOpen.narrow, "the other viewer's is untouched").toBe(false);

  useAnnotations.getState().togglePanel(false, "wide");
  expect(useAnnotations.getState().panelOpen.wide, "closing always closes").toBe(false);

  useAnnotations.getState().setListInPlace("wide", true);
  expect(useAnnotations.getState().listInPlace).toEqual({ wide: true });
});
