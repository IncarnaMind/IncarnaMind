import { expect, test, vi } from "vitest";
import { type Logger, SecretStorageError } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

const held = vi.hoisted(() => {
  let release: (available: boolean) => void = () => undefined;
  let availability = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const state = {
    dataDir: "",
    asked: 0,
    encryptCalls: 0,
    get availability() {
      return availability;
    },
    release(available: boolean) {
      release(available);
    },
    reset() {
      availability = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      state.asked = 0;
      state.encryptCalls = 0;
    },
  };
  return state;
});

vi.mock("electron", () => {
  const deep = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) => (property === "then" ? undefined : deep()),
      apply: () => deep(),
    });
  const xor = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));
  const safeStorage = {
    getSelectedStorageBackend: () => "gnome_libsecret",
    setUsePlainTextEncryption: () => undefined,
    isAsyncEncryptionAvailable: () => {
      held.asked += 1;
      return held.availability;
    },
    encryptStringAsync: async (plainText: string) => {
      held.encryptCalls += 1;
      if (!(await held.availability)) {
        throw new Error(
          "Error while encrypting the text provided to safeStorage.encryptStringAsync. Encryption is not available.",
        );
      }
      return xor(Buffer.from(plainText, "utf8"));
    },
    decryptStringAsync: async (cipherText: Buffer) => {
      if (!(await held.availability)) throw new Error("Decryption is not available.");
      return { result: xor(cipherText).toString("utf8"), shouldReEncrypt: false };
    },
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

  let resolved = false;
  const adaptersReady = Promise.resolve(createElectronAdapters(log)).then((adapters) => {
    resolved = true;
    return adapters;
  });
  await new Promise((resolve) => setImmediate(resolve));

  // Asked once, when the adapters are built, and not answered yet.
  expect(held.asked).toBe(1);
  expect(resolved).toBe(false);

  held.release(false);
  const adapters = await adaptersReady;

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
