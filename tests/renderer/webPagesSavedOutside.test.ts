import { beforeAll, describe, expect, test, vi } from "vitest";

/*
 * A page the User saves while another save is under way: when its Folder gains a wall meanwhile, the
 * page stays outside it and the User is told where it is (#2250).
 */

const answered = vi.hoisted(() => ({
  result: {
    outcome: "saved" as const,
    document: { id: "page", name: "Tea - The Open Encyclopedia" } as never,
    existing: false,
    notFiled: true,
  } as Record<string, unknown>,
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy(
    {
      saveWebPage: async () => answered.result,
    },
    { get: (target, name) => Reflect.get(target, name) ?? (async () => undefined) },
  ),
}));

type WebPages = typeof import("../../src/renderer/src/webPages");
type Store = typeof import("../../src/renderer/src/store");
let webPages: WebPages;
let store: Store;

beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  webPages = await import("../../src/renderer/src/webPages");
  store = await import("../../src/renderer/src/store");
});

describe("a page saved outside the Folder asked", () => {
  test("the User is told, with the Folder they chose", async () => {
    store.useAppStore.setState({
      library: { groups: [{ id: "other", name: "Other" }] },
      savedOutside: [],
    } as never);

    await webPages.useWebPages.getState().add(["http://encyclopedia.example/tea"], "other");

    expect(store.useAppStore.getState().savedOutside).toEqual([
      { id: "page", name: "Tea - The Open Encyclopedia", folder: "Other" },
    ]);
  });

  test("a page saved in its Folder says nothing", async () => {
    answered.result = {
      outcome: "saved",
      document: { id: "page", name: "Tea - The Open Encyclopedia" } as never,
      existing: false,
    };
    store.useAppStore.setState({ savedOutside: [] } as never);

    await webPages.useWebPages.getState().add(["http://encyclopedia.example/tea"], "other");

    expect(store.useAppStore.getState().savedOutside).toEqual([]);
  });
});
