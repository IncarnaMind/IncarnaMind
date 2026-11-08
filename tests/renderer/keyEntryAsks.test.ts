import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Language } from "../../src/core/language";

/*
 * First run's key field (#2865): a key is recognised by its form only. A form several services
 * issue asks in one line, and nothing of the key reaches the core, where every request to a
 * service starts, until the User presses Use this key, and then only for the service the line
 * named; Another service hands the key to the service choice and sends nothing either.
 */

const document = new DOMParser().parseFromString(
  "<html><head></head><body></body></html>",
  "text/html",
);
const window = document.defaultView;
/** Every call the field made to the core, with its arguments. */
const calls: { method: string; args: unknown[] }[] = [];
const answers: Record<string, (...args: unknown[]) => unknown> = {
  testChatConnection: () => ({ ok: true }),
  saveChatProvider: (input) => ({ id: "provider-1", ...(input as object) }),
};
const bridge = new Proxy(
  { on: () => () => undefined },
  {
    get: (each, name: string) =>
      name === "on"
        ? each.on
        : (...args: unknown[]) => {
            calls.push({ method: name, args });
            return Promise.resolve(answers[name]?.(...args));
          },
  },
);
Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
// How React tells, as it loads, that this document has typing events.
Object.assign(document, { oninput: null });
const globals: Record<string, unknown> = {
  document,
  window,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Event: window.Event,
  Node: window.Node,
  navigator: { languages: ["en-US"], userAgent: "node" },
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../../src/renderer/src/store");

interface KeyEntryProps {
  onSaved(): void;
  unrecognised: { label: string; run(key: string, service?: string): void };
}
// Loaded by path, as the other component tests are: the node typecheck reads no JSX.
const entryPath = "../../src/renderer/src/components/providers/KeyEntry.tsx";
const { KeyEntry } = (await import(entryPath)) as { KeyEntry: ComponentType<KeyEntryProps> };

/** Made up in the form DeepSeek's and Qwen's keys share: never a real key. */
const SHARED_KEY = `sk-${"0123456789abcdef".repeat(2)}`;
const ANTHROPIC_KEY = "sk-ant-api03-a-made-up-key-for-this-test";

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const saved = vi.fn();
const chooseService = vi.fn();

beforeEach(async () => {
  calls.length = 0;
  saved.mockReset();
  chooseService.mockReset();
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function open(language: Language) {
  useAppStore.setState({ settings: { language } as never });
  await act(async () =>
    root.render(
      createElement(KeyEntry, {
        onSaved: saved,
        unrecognised: { label: "setup.key.chooseService", run: chooseService },
      }),
    ),
  );
}

const find = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

/** Pastes `key` into the field, as the system's paste does. */
const paste = (key: string) =>
  act(async () => {
    const field = find("setup-key");
    if (!(field instanceof window.HTMLInputElement)) throw new Error("The key field isn't there.");
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      field,
      key,
    );
    const event = new window.Event("input", { bubbles: true });
    Object.defineProperty(event, "inputType", { value: "insertFromPaste" });
    field.dispatchEvent(event);
  });

const press = (testId: string) =>
  act(async () => {
    const button = find(testId);
    if (!button) throw new Error(`Nothing to press: ${testId}`);
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });

/** Whether any call to the core so far carried the key, in any argument. */
const keyLeft = (key: string) => JSON.stringify(calls).includes(key);

test("in Chinese, a key DeepSeek and Qwen share asks in one line and goes nowhere until Use this key, then only to DeepSeek", async () => {
  await open("zh-CN");
  await paste(SHARED_KEY);

  expect(find("setup-key-ask")?.textContent).toBe("是 DeepSeek 吗？· 使用这个密钥 · 换一个服务");
  expect(find("setup-key-line")).toBeNull();
  expect(keyLeft(SHARED_KEY), JSON.stringify(calls)).toBe(false);
  expect(saved).not.toHaveBeenCalled();

  await press("setup-key-use");

  // The press sends the key to DeepSeek alone: tested, then saved, which records the consent.
  const carrying = calls.filter((call) => JSON.stringify(call.args).includes(SHARED_KEY));
  expect(carrying.map((call) => [call.method, call.args[0]])).toEqual([
    ["testChatConnection", expect.objectContaining({ catalogId: "deepseek", apiKey: SHARED_KEY })],
    ["saveChatProvider", expect.objectContaining({ catalogId: "deepseek", apiKey: SHARED_KEY })],
  ]);
  expect(saved).toHaveBeenCalledTimes(1);
});

test("Another service hands the key to the service choice, on the next service its form may be, and sends nothing", async () => {
  await open("zh-CN");
  await paste(SHARED_KEY);
  await press("setup-key-other-service");

  expect(chooseService).toHaveBeenCalledWith(SHARED_KEY, "qwen");
  expect(keyLeft(SHARED_KEY), JSON.stringify(calls)).toBe(false);
});

test("a key DeepSeek refuses after Use this key offers Another service, and never goes to a second service by itself", async () => {
  answers.testChatConnection = () => ({
    ok: false,
    error: { kind: "auth", message: "Authentication Fails" },
  });
  try {
    await open("zh-CN");
    await paste(SHARED_KEY);
    await press("setup-key-use");

    expect(find("setup-key-refused")?.textContent).toBe(
      "服务拒绝了这个密钥 · 检查密钥 · 换一个服务",
    );
    const carrying = () => calls.filter((call) => JSON.stringify(call.args).includes(SHARED_KEY));
    expect(carrying().map((call) => call.method)).toEqual(["testChatConnection"]);
    await press("setup-key-other-service");
    expect(chooseService).toHaveBeenCalledWith(SHARED_KEY, "qwen");
    expect(carrying()).toHaveLength(1);
  } finally {
    answers.testChatConnection = () => ({ ok: true });
  }
});

test("in English the same key asks the same way, in English", async () => {
  await open("en");
  await paste(SHARED_KEY);

  expect(find("setup-key-ask")?.textContent).toBe("DeepSeek? · Use this key · Another service");
  expect(keyLeft(SHARED_KEY)).toBe(false);
});

test("a key whose form names its service is tested at once, as before", async () => {
  await open("zh-CN");
  await paste(ANTHROPIC_KEY);

  expect(find("setup-key-ask")).toBeNull();
  const tests = calls.filter((call) => call.method === "testChatConnection");
  expect(tests[0]?.args[0]).toMatchObject({ catalogId: "anthropic", apiKey: ANTHROPIC_KEY });
});

test("a key no service issues offers the service choice and sends nothing", async () => {
  await open("zh-CN");
  await paste("pk-live-a-key-from-a-service-we-dont-list");

  expect(find("setup-key-unrecognised")?.textContent).toBe("无法识别这个密钥所属的服务 · 选择服务");
  expect(keyLeft("pk-live-a-key-from-a-service-we-dont-list")).toBe(false);
  await press("setup-key-choose-service");
  expect(chooseService).toHaveBeenCalledWith("pk-live-a-key-from-a-service-we-dont-list");
});
