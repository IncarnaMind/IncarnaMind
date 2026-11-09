import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Language } from "../../src/core/language";
import type { KeyTarget } from "../../src/core/providers/catalog/keyForms";

/*
 * First run's key field (#2865): a key is recognised by its form only. A form that doesn't decide
 * where the key goes asks in one line, naming the host, and nothing of the key reaches the core,
 * where every request to a service starts, until the User presses Use this key, and then only for
 * the host the line named. Another service hands the key to the service choice and sends nothing
 * either. Every check runs after the timers have run, so a call made later would be seen too.
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
  unrecognised: { label: string; run(key: string, next?: KeyTarget): void };
}
// Loaded by path, as the other component tests are: the node typecheck reads no JSX.
const entryPath = "../../src/renderer/src/components/providers/KeyEntry.tsx";
const { KeyEntry } = (await import(entryPath)) as { KeyEntry: ComponentType<KeyEntryProps> };

/** Made up in the forms DeepSeek's, Qwen's and GLM's keys take: never a real key. */
const SHARED_KEY = `sk-${"0123456789abcdef".repeat(2)}`;
const GLM_KEY = `${"0123456789abcdef".repeat(2)}.${"aZ3".repeat(5)}a`;
const ANTHROPIC_KEY = "sk-ant-api03-a-made-up-key-for-this-test";

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const saved = vi.fn();
const chooseService = vi.fn();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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
  vi.useRealTimers();
});

/** Runs every timer the field set, and what they started, so a late call is seen too. */
const settle = () => act(async () => vi.runAllTimersAsync());

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

function field(): HTMLInputElement {
  const input = find("setup-key");
  if (!(input instanceof window.HTMLInputElement)) throw new Error("The key field isn't there.");
  return input;
}

/** Puts `key` in the field as typing or a paste does. */
async function enter(key: string, inputType: "insertFromPaste" | "insertText") {
  await act(async () => {
    const input = field();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      input,
      key,
    );
    const event = new window.Event("input", { bubbles: true });
    Object.defineProperty(event, "inputType", { value: inputType });
    input.dispatchEvent(event);
  });
  await settle();
}

const paste = (key: string) => enter(key, "insertFromPaste");

async function pressEnter() {
  await act(async () => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: "Enter" });
    field().dispatchEvent(event);
  });
  await settle();
}

async function press(testId: string) {
  await act(async () => {
    const button = find(testId);
    if (!button) throw new Error(`Nothing to press: ${testId}`);
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await settle();
}

/** The calls to the core that carried the key, in any argument. */
const carrying = (key: string) => calls.filter((call) => JSON.stringify(call.args).includes(key));

test("in Chinese, a key DeepSeek and Qwen share asks in one line and goes nowhere until Use this key, then only to DeepSeek", async () => {
  await open("zh-CN");
  await paste(SHARED_KEY);

  expect(find("setup-key-ask")?.textContent).toBe("是 DeepSeek 吗？· 使用这个密钥 · 换一个服务");
  expect(find("setup-key-line")).toBeNull();
  expect(carrying(SHARED_KEY), JSON.stringify(calls)).toEqual([]);
  expect(saved).not.toHaveBeenCalled();

  await press("setup-key-use");

  // The press sends the key to DeepSeek alone: tested, then saved, which records the consent.
  expect(carrying(SHARED_KEY).map((call) => [call.method, call.args[0]])).toEqual([
    ["testChatConnection", expect.objectContaining({ catalogId: "deepseek", apiKey: SHARED_KEY })],
    ["saveChatProvider", expect.objectContaining({ catalogId: "deepseek", apiKey: SHARED_KEY })],
  ]);
  expect(saved).toHaveBeenCalledTimes(1);
});

test("a GLM key asks about the language's platform by name, and Use this key sends it to that host only", async () => {
  await open("zh-CN");
  await paste(GLM_KEY);

  expect(find("setup-key-ask")?.textContent).toBe(
    "是智谱 BigModel 吗？· 使用这个密钥 · 换一个服务",
  );
  expect(carrying(GLM_KEY)).toEqual([]);

  await press("setup-key-use");
  expect(carrying(GLM_KEY).map((call) => [call.method, call.args[0]])).toEqual([
    [
      "testChatConnection",
      expect.objectContaining({ catalogId: "glm", endpoint: "cn", apiKey: GLM_KEY }),
    ],
    ["saveChatProvider", expect.objectContaining({ catalogId: "glm", endpoint: "cn" })],
  ]);
});

test("says what a key sends under the field before a paste, and keeps it under the question (#2883)", async () => {
  await open("en");
  expect(find("setup-key-sends")?.textContent).toBe(
    "What you ask, edit or check, with the Notes and the parts of your Documents it needs, goes to the service your key is for.",
  );
  await paste(SHARED_KEY);
  expect(find("setup-key-ask")).not.toBeNull();
  // Nothing goes before the User's Use: the line changes no request.
  expect(carrying(SHARED_KEY)).toEqual([]);
  expect(find("setup-key-sends")?.textContent).toBe(
    "What you ask, edit or check, with the Notes and the parts of your Documents it needs, goes to the service your key is for.",
  );

  await open("zh-CN");
  expect(find("setup-key-sends")?.textContent).toBe(
    "你提问、修改或核对的内容，连同所需的笔记和文档内容，会发送到密钥所属的服务。",
  );
});

test("in English a GLM key asks about Z.ai, and Another service offers the other platform without sending", async () => {
  await open("en");
  await paste(GLM_KEY);

  expect(find("setup-key-ask")?.textContent).toBe("Z.ai (GLM)? · Use this key · Another service");
  await press("setup-key-other-service");
  expect(chooseService).toHaveBeenCalledWith(GLM_KEY, { service: "glm", region: "cn" });
  expect(carrying(GLM_KEY)).toEqual([]);
});

test("Model Studio's sk-ws key names the region it would go to", async () => {
  await open("zh-CN");
  await paste("sk-ws-0123456789abcdef0123456789abcdef0123456789");
  expect(find("setup-key-ask")?.textContent).toBe(
    "是通义千问（中国内地）吗？· 使用这个密钥 · 换一个服务",
  );
  await press("setup-key-use");
  expect(carrying("sk-ws-0123456789abcdef").map((call) => call.args[0])).toEqual([
    expect.objectContaining({ catalogId: "qwen", endpoint: "cn" }),
    expect.objectContaining({ catalogId: "qwen", endpoint: "cn" }),
  ]);
});

test("Another service hands the key to the service choice, on the next place its form may go, and sends nothing", async () => {
  await open("zh-CN");
  await paste(SHARED_KEY);
  await press("setup-key-other-service");

  expect(chooseService).toHaveBeenCalledWith(SHARED_KEY, { service: "qwen", region: null });
  expect(carrying(SHARED_KEY), JSON.stringify(calls)).toEqual([]);
});

test("typed and sent with Enter, the key asks the same way and sends nothing", async () => {
  await open("zh-CN");
  await enter(SHARED_KEY, "insertText");
  expect(find("setup-key-ask")).toBeNull();
  await pressEnter();

  expect(find("setup-key-ask")?.textContent).toBe("是 DeepSeek 吗？· 使用这个密钥 · 换一个服务");
  expect(carrying(SHARED_KEY)).toEqual([]);
});

test("a second paste asks again about the new key, and sends neither", async () => {
  await open("zh-CN");
  await paste(SHARED_KEY);
  const second = `sk-${"fedcba9876543210".repeat(2)}`;
  await paste(second);

  expect(find("setup-key-ask")?.textContent).toBe("是 DeepSeek 吗？· 使用这个密钥 · 换一个服务");
  expect(carrying(SHARED_KEY)).toEqual([]);
  expect(carrying(second)).toEqual([]);
  await press("setup-key-use");
  expect(carrying(second).map((call) => call.method)).toEqual([
    "testChatConnection",
    "saveChatProvider",
  ]);
  expect(carrying(SHARED_KEY)).toEqual([]);
});

test("blank text pasted over an asked key takes the question away, so Use this key can't send the key that's gone", async () => {
  await open("zh-CN");
  await paste(SHARED_KEY);
  await paste("   ");

  expect(find("setup-key-ask")).toBeNull();
  expect(find("setup-key-line")).not.toBeNull();
  expect(carrying(SHARED_KEY)).toEqual([]);
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
    expect(carrying(SHARED_KEY).map((call) => call.method)).toEqual(["testChatConnection"]);
    await press("setup-key-other-service");
    expect(chooseService).toHaveBeenCalledWith(SHARED_KEY, { service: "qwen", region: null });
    expect(carrying(SHARED_KEY)).toHaveLength(1);

    // Another key pasted after the refusal asks again, rather than leaving no line at all.
    const next = `sk-${"fedcba9876543210".repeat(2)}`;
    await paste(next);
    expect(find("setup-key-ask")?.textContent).toBe("是 DeepSeek 吗？· 使用这个密钥 · 换一个服务");
    expect(carrying(next)).toEqual([]);
    expect(carrying(SHARED_KEY)).toHaveLength(1);
  } finally {
    answers.testChatConnection = () => ({ ok: true });
  }
});

test("in English the same key asks the same way, in English", async () => {
  await open("en");
  await paste(SHARED_KEY);

  expect(find("setup-key-ask")?.textContent).toBe("DeepSeek? · Use this key · Another service");
  expect(carrying(SHARED_KEY)).toEqual([]);
});

test("a key whose form names a service with one host is tested at once, as before", async () => {
  await open("zh-CN");
  await paste(ANTHROPIC_KEY);

  expect(find("setup-key-ask")).toBeNull();
  expect(carrying(ANTHROPIC_KEY)[0]?.args[0]).toMatchObject({
    catalogId: "anthropic",
    apiKey: ANTHROPIC_KEY,
  });
});

test("a key no service issues offers the service choice and sends nothing", async () => {
  const key = "pk-live-a-key-from-a-service-we-dont-list";
  await open("zh-CN");
  await paste(key);

  expect(find("setup-key-unrecognised")?.textContent).toBe("无法识别这个密钥所属的服务 · 选择服务");
  expect(carrying(key)).toEqual([]);
  await press("setup-key-choose-service");
  expect(chooseService).toHaveBeenCalledWith(key);
  expect(carrying(key)).toEqual([]);
});
