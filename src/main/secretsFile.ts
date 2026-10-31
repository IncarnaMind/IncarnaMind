/**
 * Storage behind the `Keychain` adapter: secrets encrypted by a `SecretCipher`
 * (Electron `safeStorage` in the app) and kept as base64 ciphertext in one
 * small file in the data folder. Never in SQLite, and never synced (ADR-0003).
 *
 * This module doesn't import Electron, so tests can run it with a fake cipher.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { type Keychain, type SecretProtection, SecretsFileDamagedError } from "../core";

/** The secrets file's name in the data folder. */
export const SECRETS_FILE = "secrets.json";

/** What `safeStorage` provides: the core's view of protection, and string encryption. */
export interface SecretCipher {
  protection(): SecretProtection;
  /** Lets encryption work without a keyring (Linux "basic_text"), after the User accepted the risk. */
  allowPlainText(): void;
  encrypt(plainText: string): Buffer;
  decrypt(cipherText: Buffer): string;
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

export function createFileKeychain(file: string, cipher: SecretCipher): Keychain {
  let plainTextAllowed = false;

  // Every read-modify-write runs one at a time, so concurrent saves don't drop each other's secrets.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const load = async (): Promise<Record<string, string>> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new SecretsFileDamagedError(file, { cause: error });
    }
    let entries: unknown;
    try {
      entries = JSON.parse(text);
    } catch (error) {
      throw new SecretsFileDamagedError(file, { cause: error });
    }
    if (!isStringRecord(entries)) throw new SecretsFileDamagedError(file);
    return entries;
  };

  const save = async (entries: Record<string, string>) => {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
    await rename(temporary, file);
  };

  const assertProtected = () => {
    const protection = cipher.protection();
    if (protection === "unavailable") {
      throw new Error("This system can't encrypt secrets, so they can't be stored.");
    }
    if (protection === "plain-text" && !plainTextAllowed) {
      throw new Error("No keyring is running, so secrets would be stored in plain text.");
    }
  };

  return {
    protection: () => cipher.protection(),

    allowPlainText() {
      plainTextAllowed = true;
      cipher.allowPlainText();
    },

    get: (name) =>
      serially(async () => {
        const entries = await load();
        if (!Object.hasOwn(entries, name)) return null;
        assertProtected();
        return cipher.decrypt(Buffer.from(entries[name] as string, "base64"));
      }),

    set: (name, secret) =>
      serially(async () => {
        assertProtected();
        const entries = await load();
        entries[name] = cipher.encrypt(secret).toString("base64");
        await save(entries);
      }),

    delete: (name) =>
      serially(async () => {
        const entries = await load();
        if (!Object.hasOwn(entries, name)) return;
        delete entries[name];
        await save(entries);
      }),
  };
}
