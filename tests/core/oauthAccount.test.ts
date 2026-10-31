import { describe, expect, onTestFinished, test, vi } from "vitest";
import { type Browser, SecretsFileDamagedError } from "../../src/core";
import {
  createOAuthAccount,
  type OAuthAccountRecord,
  parseAccountRecord,
  type RefreshLock,
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

/** A mutex like the shared refresh lock: one task at a time, in order. */
function serialLock(): RefreshLock {
  let tail = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/** A secret store over one shared value; `write` may hold the write it is given. */
function sharedStore(read: () => string | null, write: (value: string) => Promise<void>): Secrets {
  const status = { protection: "os", plainTextAccepted: false, canSave: true } as const;
  return {
    status: () => status,
    acceptPlainText: () => status,
    get: async () => read(),
    tryGet: async () => read(),
    set: async (_name, value) => write(value),
    delete: async () => undefined,
  };
}

function accountStoredIn(secrets: Secrets, refreshLock?: RefreshLock) {
  return createOAuthAccount<Account>({
    secretName: "chatgpt:account",
    provider: "ChatGPT",
    secrets,
    ...(refreshLock && { refreshLock }),
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

  test("the shared lock keeps a refusal from clobbering a sign-in finished in between", async () => {
    const tokenless: Account = { tokens: null, ended: "signed-out", profile: "own" };
    const finished: Account = {
      tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 1 },
      ended: null,
      profile: "own",
    };
    let current = JSON.stringify(tokenless);
    let beganWrite = () => {};
    const writing = new Promise<void>((resolve) => {
      beganWrite = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = serialLock();
    const refusing = accountStoredIn(
      sharedStore(
        () => current,
        async (value) => {
          beganWrite();
          await held;
          current = value;
        },
      ),
      lock,
    );
    const finishing = accountStoredIn(
      sharedStore(
        () => current,
        async (value) => {
          current = value;
        },
      ),
      lock,
    );

    const refusal = refusing.commitUnlessSignedIn((found) => ({
      ...(found ?? tokenless),
      ended: "signed-out",
    }));
    await writing;
    const success = finishing.commit(finished);
    release();
    await Promise.all([refusal, success]);

    expect(current).toBe(JSON.stringify(finished));
  });

  test("a completed sign-in replaces the record, which only commit writes", async () => {
    const store = secretStore(async () => "not a sign-in record");
    const account = accountStoredIn(store.secrets);

    await account.commit({ tokens: null, ended: null, profile: "own" });

    expect(store.written()).toBe(JSON.stringify({ tokens: null, ended: null, profile: "own" }));
  });
});
