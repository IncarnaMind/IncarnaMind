/**
 * The list beside a page (#327): it opens only in a viewer with room for it, by
 * that viewer's own width, so one viewer's size never closes or disables another's.
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

test("the list opens only in a viewer that has room, and one viewer's size is not another's", async () => {
  const { useAnnotations } = await import("../../src/renderer/src/annotations");
  useAnnotations.setState({ panelOpen: false, room: {} });

  useAnnotations.getState().setRoom("narrow", false);
  useAnnotations.getState().setRoom("wide", true);
  useAnnotations.getState().togglePanel(true, "narrow");
  expect(useAnnotations.getState().panelOpen, "no room: it stays closed").toBe(false);

  useAnnotations.getState().togglePanel(true, "wide");
  expect(useAnnotations.getState().panelOpen, "room: it opens").toBe(true);

  useAnnotations.getState().togglePanel(false);
  expect(useAnnotations.getState().panelOpen, "closing always closes").toBe(false);

  useAnnotations.getState().togglePanel(true);
  expect(
    useAnnotations.getState().panelOpen,
    "a caller with no Document keeps the former behaviour",
  ).toBe(true);
});
