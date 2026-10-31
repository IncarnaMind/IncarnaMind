import { describe, expect, onTestFinished, test, vi } from "vitest";
import { type Browser, SecretsFileDamagedError } from "../../src/core";
import {
  createOAuthAccount,
  type OAuthAccountRecord,
  parseAccountRecord,
  SignInRecordUnreadableError,
  SignInStoreUnreadableError,
} from "../../src/core/oauthAccount";
import type { Secrets } from "../../src/core/secrets";

type Account = OAuthAccountRecord & { profile: string };

/** A secret store whose one record is read by `read`; `written` is what was saved over it. */
function secretStore(read: () => Promise<string | null>) {
  let written: string | null = null;
  const status = { protection: "os", plainTextAccepted: false, canSave: true } as const;
  const secrets: Secrets = {
    status: () => status,
    acceptPlainText: () => status,
    get: read,
    tryGet: async () => {
      try {
        return await read();
      } catch {
        return null;
      }
    },
    set: async (_name, value) => {
      written = value;
    },
    delete: async () => undefined,
  };
  return { secrets, written: () => written };
}

function accountStoredIn(secrets: Secrets) {
  return createOAuthAccount<Account>({
    secretName: "chatgpt:account",
    provider: "ChatGPT",
    secrets,
    parse: (record) =>
      typeof record.profile === "string"
        ? { ...parseAccountRecord(record), profile: record.profile }
        : null,
    browser: { open: async () => undefined } satisfies Browser,
    now: () => Date.parse("2026-10-31T00:00:00.000Z"),
    renew: async () => {
      throw new Error("This test never refreshes.");
    },
    signInRequired: () => new Error("Not signed in."),
    onChange: () => undefined,
  });
}

describe("A kept sign-in's record", () => {
  test("nothing stored is absent: the sign-in is required, not unreadable", async () => {
    const account = accountStoredIn(secretStore(async () => null).secrets);

    expect(await account.load()).toBeNull();
    await expect(account.credentials.access()).rejects.toThrow("Not signed in.");
  });

  test("a stored value that isn't a record is unreadable, and access says so instead of signing out", async () => {
    const account = accountStoredIn(secretStore(async () => "not a sign-in record").secrets);

    const failure = account.load();
    await expect(failure).rejects.toBeInstanceOf(SignInRecordUnreadableError);
    await expect(failure).rejects.toMatchObject({
      provider: "ChatGPT",
      wording: { key: "error.signIn.unreadable", values: { provider: "ChatGPT" } },
    });
    await expect(account.credentials.access()).rejects.toBeInstanceOf(SignInRecordUnreadableError);
    expect(await account.loadOrNull()).toBeNull();
  });

  test("a record the keychain can't decrypt is unreadable, and reading it writes nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    const store = secretStore(async () => {
      throw new Error("The key that encrypted it is gone.");
    });
    const account = accountStoredIn(store.secrets);

    await expect(account.load()).rejects.toBeInstanceOf(SignInRecordUnreadableError);
    expect(await account.loadOrNull()).toBeNull();
    expect(store.written()).toBeNull();
  });

  test("a store that can't be read is its own error, not a record one, and still has nothing to end", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    const store = secretStore(async () => {
      throw new SecretsFileDamagedError("/tmp/secrets.json");
    });
    const account = accountStoredIn(store.secrets);

    const failure = account.load();
    await expect(failure).rejects.toBeInstanceOf(SignInStoreUnreadableError);
    await expect(failure).rejects.toMatchObject({
      provider: "ChatGPT",
      wording: { key: "error.signIn.storeUnreadable", values: { provider: "ChatGPT" } },
    });
    await expect(account.credentials.access()).rejects.toBeInstanceOf(SignInStoreUnreadableError);
    expect(await account.loadOrNull()).toBeNull();
    expect(await account.signOut()).toEqual({ revoked: true });
    expect(store.written()).toBeNull();
  });

  test("signing out of a record that can't be read has nothing to end and touches nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    const store = secretStore(async () => "not a sign-in record");
    const account = accountStoredIn(store.secrets);

    expect(await account.signOut()).toEqual({ revoked: true });
    expect(store.written()).toBeNull();
  });

  test("a refusal writes nothing over a sign-in another process finished while it waited", async () => {
    const tokenless = JSON.stringify({ tokens: null, ended: null, profile: "own" });
    const finished = JSON.stringify({
      tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 1 },
      ended: null,
      profile: "own",
    });
    let reads = 0;
    const store = secretStore(async () => (reads++ === 0 ? tokenless : finished));
    const account = accountStoredIn(store.secrets);

    expect((await account.load())?.tokens).toBeNull();
    await account.commitUnlessSignedIn((current) => ({
      ...(current ?? { tokens: null, ended: null, profile: "own" }),
      ended: "signed-out",
    }));

    expect(store.written()).toBeNull();
  });

  test("a completed sign-in replaces the record, which only commit writes", async () => {
    const store = secretStore(async () => "not a sign-in record");
    const account = accountStoredIn(store.secrets);

    await account.commit({ tokens: null, ended: null, profile: "own" });

    expect(store.written()).toBe(JSON.stringify({ tokens: null, ended: null, profile: "own" }));
  });
});
