import { afterEach, expect, test, vi } from "vitest";
import { type Logger, SecretStorageError } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

const held = vi.hoisted(() => {
  let resolve: (available: boolean) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  let availability = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const state = {
    dataDir: "",
    backend: "gnome_libsecret",
    asked: 0,
    encryptCalls: 0,
    plainTextAllowed: false,
    plainTextAllowedAtEncrypt: null as boolean | null,
    get availability() {
      return availability;
    },
    release(available: boolean) {
      resolve(available);
    },
    rejectWith(error: Error) {
      reject(error);
    },
    reset() {
      availability = new Promise<boolean>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      state.backend = "gnome_libsecret";
      state.asked = 0;
      state.encryptCalls = 0;
      state.plainTextAllowed = false;
      state.plainTextAllowedAtEncrypt = null;
    },
  };
  return state;
});

afterEach(() => vi.restoreAllMocks());

vi.mock("electron", () => {
  const deep = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) => (property === "then" ? undefined : deep()),
      apply: () => deep(),
    });
  const xor = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));
  const safeStorage = {
    getSelectedStorageBackend: () => held.backend,
    setUsePlainTextEncryption: (use: boolean) => {
      if (use) held.plainTextAllowed = true;
    },
    isAsyncEncryptionAvailable: () => {
      held.asked += 1;
      return held.availability;
    },
    encryptStringAsync: async (plainText: string) => {
      held.encryptCalls += 1;
      held.plainTextAllowedAtEncrypt = held.plainTextAllowed;
      return xor(Buffer.from(plainText, "utf8"));
    },
    decryptStringAsync: async (cipherText: Buffer) => ({
      result: xor(cipherText).toString("utf8"),
      shouldReEncrypt: false,
    }),
  };
  const appTarget: Record<string, unknown> = {
    getPath: () => held.dataDir,
    getVersion: () => "0.0.0",
    getAppPath: () => held.dataDir,
    isPackaged: false,
    getPreferredSystemLanguages: () => ["en-US"],
    getLocaleCountryCode: () => "US",
  };
  const app = new Proxy(appTarget, {
    get: (target, property: string) => (property in target ? target[property] : deep()),
  });
  const module: Record<string, unknown> = { app, safeStorage };
  for (const name of [
    "autoUpdater",
    "BaseWindow",
    "BrowserWindow",
    "ipcMain",
    "Menu",
    "nativeTheme",
    "nativeUpdater",
    "net",
    "Notification",
    "protocol",
    "screen",
    "session",
    "shell",
    "utilityProcess",
    "WebContentsView",
    "dialog",
    "powerMonitor",
    "clipboard",
    "nativeImage",
    "systemPreferences",
    "desktopCapturer",
    "webContents",
  ]) {
    module[name] = deep();
  }
  return { ...module, default: module };
});

vi.mock("../../src/main/embedder", () => ({ createUtilityProcessEmbedder: () => ({}) }));
vi.mock("../../src/main/reranker", () => ({ createUtilityProcessCrossEncoder: () => ({}) }));
vi.mock("../../src/main/transcriber", () => ({ createUtilityProcessTranscriber: () => ({}) }));
vi.mock("../../src/main/speakerSeparator", () => ({ createUtilityProcessSeparator: () => ({}) }));
vi.mock("../../src/main/scanReader", () => ({ createUtilityProcessTextRecognizer: () => ({}) }));

const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

test("the adapters wait for the system store's answer, and a refused save is worded", async () => {
  held.reset();
  held.dataDir = await createTempDataFolder();
  const { createElectronAdapters } = await import("../../src/main/platform");
  const logged = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  let resolved = false;
  const adaptersReady = Promise.resolve(createElectronAdapters(logged)).then((adapters) => {
    resolved = true;
    return adapters;
  });
  await new Promise((resolve) => setImmediate(resolve));

  // Asked once, when the adapters are built, and not answered yet: the log says what it waits on.
  expect(held.asked).toBe(1);
  expect(resolved).toBe(false);
  expect(logged.info).toHaveBeenCalledWith("secrets.encryption.waiting");
  expect(logged.info).not.toHaveBeenCalledWith("secrets.encryption.ready", expect.anything());

  held.release(false);
  const adapters = await adaptersReady;
  expect(logged.info).toHaveBeenCalledWith("secrets.encryption.ready", {
    protection: "unavailable",
  });

  const core = startCore(await createTempDataFolder(), { keychain: adapters.keychain });
  expect(await core.getSecretStorage()).toEqual({
    protection: "unavailable",
    plainTextAccepted: false,
    canSave: false,
  });

  const saving = core.saveChatProvider({
    kind: "openai",
    apiKey: "sk-test-held-0123456789",
    modelId: "gpt-5.4-mini",
  });
  await expect(saving).rejects.toBeInstanceOf(SecretStorageError);
  await expect(saving).rejects.toThrow(
    "This system can’t encrypt API keys, so they can’t be saved.",
  );
  // The worded refusal came before the encryptor was asked.
  expect(held.encryptCalls).toBe(0);
  core.close();
});

test("an answer of yes makes the system store the protection", async () => {
  held.reset();
  held.dataDir = await createTempDataFolder();
  const { createElectronAdapters } = await import("../../src/main/platform");

  const adaptersReady = Promise.resolve(createElectronAdapters(log));
  held.release(true);
  const adapters = await adaptersReady;

  const core = startCore(await createTempDataFolder(), { keychain: adapters.keychain });
  expect(await core.getSecretStorage()).toEqual({
    protection: "os",
    plainTextAccepted: false,
    canSave: true,
  });
  core.close();
});

test("a rejected availability check fails closed and logs only the reason", async () => {
  held.reset();
  held.dataDir = await createTempDataFolder();
  const logged = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const { createElectronAdapters } = await import("../../src/main/platform");

  const adaptersReady = Promise.resolve(createElectronAdapters(logged));
  await new Promise((resolve) => setImmediate(resolve));
  expect(held.asked).toBe(1);
  held.rejectWith(new Error("The keyring is locked."));
  const adapters = await adaptersReady;

  expect(logged.warn).toHaveBeenCalledWith("secrets.encryption", {
    reason: "The keyring is locked.",
  });
  const core = startCore(await createTempDataFolder(), { keychain: adapters.keychain });
  expect(await core.getSecretStorage()).toEqual({
    protection: "unavailable",
    plainTextAccepted: false,
    canSave: false,
  });

  const saving = core.saveChatProvider({
    kind: "openai",
    apiKey: "sk-test-rejected-0123456789",
    modelId: "gpt-5.4-mini",
  });
  await expect(saving).rejects.toBeInstanceOf(SecretStorageError);
  expect(held.encryptCalls).toBe(0);
  core.close();
});

test("Linux without a keyring never asks, and plain text is on before the first encrypt", async () => {
  held.reset();
  held.backend = "basic_text";
  held.dataDir = await createTempDataFolder();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const { createElectronAdapters } = await import("../../src/main/platform");

  const adaptersReady = Promise.resolve(createElectronAdapters(log));
  // If the cipher wrongly asks, answering here makes the test fail at its first check instead of hanging to the timeout.
  held.release(true);
  const adapters = await adaptersReady;
  const core = startCore(await createTempDataFolder(), { keychain: adapters.keychain });

  expect(held.asked).toBe(0);
  expect(await core.getSecretStorage()).toEqual({
    protection: "plain-text",
    plainTextAccepted: false,
    canSave: false,
  });
  const refused = core.saveChatProvider({
    kind: "openai",
    apiKey: "sk-test-plain-0123456789",
    modelId: "gpt-5.4-mini",
  });
  await expect(refused).rejects.toBeInstanceOf(SecretStorageError);
  await expect(refused).rejects.toThrow(
    "No keyring running, so keys would be unencrypted. Start GNOME Keyring or KWallet.",
  );

  await core.acceptPlainTextSecretStorage();
  await core.saveChatProvider({
    kind: "openai",
    apiKey: "sk-test-plain-0123456789",
    modelId: "gpt-5.4-mini",
  });
  expect(held.plainTextAllowedAtEncrypt).toBe(true);
  expect(await core.listChatProviders()).toEqual([expect.objectContaining({ hasApiKey: true })]);
  core.close();
});
