import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SecretsFileDamagedError } from "../../src/core";
import { createFileKeychain, SECRETS_FILE } from "../../src/main/secretsFile";
import { createFakeCipher } from "../helpers/cipher";
import { createTempDataFolder } from "../helpers/core";

const SECRET = "sk-test-0123456789-very-secret";

describe("The secrets file behind the Keychain adapter", () => {
  test("keeps only ciphertext, in a secrets file in the data folder", async () => {
    const file = join(await createTempDataFolder(), SECRETS_FILE);
    const keychain = createFileKeychain(file, createFakeCipher());

    await keychain.set("chat-provider:1:api-key", SECRET);

    const text = await readFile(file, "utf8");
    expect(text).not.toContain(SECRET);
    expect(Object.keys(JSON.parse(text))).toEqual(["chat-provider:1:api-key"]);
    expect(await keychain.get("chat-provider:1:api-key")).toBe(SECRET);
  });

  test("secrets survive a restart", async () => {
    const file = join(await createTempDataFolder(), SECRETS_FILE);
    await createFileKeychain(file, createFakeCipher()).set("token", SECRET);

    const reopened = createFileKeychain(file, createFakeCipher());

    expect(await reopened.get("token")).toBe(SECRET);
    expect(await reopened.get("missing")).toBeNull();
  });

  test.skipIf(process.platform === "win32")("only the User can read the file", async () => {
    const file = join(await createTempDataFolder(), SECRETS_FILE);
    await createFileKeychain(file, createFakeCipher()).set("token", SECRET);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("saving several secrets at once keeps all of them", async () => {
    const file = join(await createTempDataFolder(), SECRETS_FILE);
    const keychain = createFileKeychain(file, createFakeCipher());

    await Promise.all(["a", "b", "c", "d"].map((name) => keychain.set(name, `secret-${name}`)));

    expect(await keychain.get("a")).toBe("secret-a");
    expect(await keychain.get("d")).toBe("secret-d");
  });

  test("deleting removes only that secret", async () => {
    const file = join(await createTempDataFolder(), SECRETS_FILE);
    const keychain = createFileKeychain(file, createFakeCipher());
    await keychain.set("keep", "1");
    await keychain.set("drop", "2");

    await keychain.delete("drop");
    await keychain.delete("never-stored");

    expect(await keychain.get("drop")).toBeNull();
    expect(await keychain.get("keep")).toBe("1");
  });

  test("without a keyring (basic_text), it refuses to store until plain text is allowed", async () => {
    const file = join(await createTempDataFolder(), SECRETS_FILE);
    const cipher = createFakeCipher("plain-text");
    const keychain = createFileKeychain(file, cipher);

    expect(keychain.protection()).toBe("plain-text");
    await expect(keychain.set("token", SECRET)).rejects.toThrow(/plain text/);

    keychain.allowPlainText();
    await keychain.set("token", SECRET);

    expect(cipher.plainTextAllowed).toBe(true);
    expect(await keychain.get("token")).toBe(SECRET);
  });

  test("it refuses to store anything when encryption is unavailable", async () => {
    const file = join(await createTempDataFolder(), SECRETS_FILE);
    const keychain = createFileKeychain(file, createFakeCipher("unavailable"));

    await expect(keychain.set("token", SECRET)).rejects.toThrow(/can't encrypt/);
  });

  test.each([
    { name: "empty", contents: "" },
    { name: "truncated JSON", contents: '{"token":"abc' },
    { name: "not a record of secrets", contents: "[1, 2, 3]" },
  ])("a file that is $name is damaged, and nothing is written over it", async ({ contents }) => {
    const file = join(await createTempDataFolder(), SECRETS_FILE);
    await writeFile(file, contents);
    const keychain = createFileKeychain(file, createFakeCipher());

    await expect(keychain.get("token")).rejects.toBeInstanceOf(SecretsFileDamagedError);
    await expect(keychain.set("token", SECRET)).rejects.toBeInstanceOf(SecretsFileDamagedError);
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  test("a folder where the secrets file belongs is damaged too", async () => {
    const file = join(await createTempDataFolder(), SECRETS_FILE);
    await mkdir(file);
    const keychain = createFileKeychain(file, createFakeCipher());

    await expect(keychain.get("token")).rejects.toBeInstanceOf(SecretsFileDamagedError);
    await expect(keychain.set("token", SECRET)).rejects.toBeInstanceOf(SecretsFileDamagedError);
  });
});
