import { describe, expect, test } from "vitest";
import type { SecretStorageStatus } from "../../src/core/api";
import { storageReady } from "../../src/renderer/src/components/connectors/signInStorage";

const status = (canSave: boolean): SecretStorageStatus => ({
  protection: canSave ? "os" : "unavailable",
  plainTextAccepted: false,
  canSave,
});

describe("Whether a remote Connector's sign-in may start (#2025)", () => {
  test("not until the keychain's answer has arrived", () => {
    expect(storageReady(null, false)).toBe(false);
  });

  test("never when reading the keychain failed", () => {
    expect(storageReady(null, true)).toBe(false);
    expect(storageReady(status(true), true)).toBe(false);
  });

  test("when the keychain can save", () => {
    expect(storageReady(status(true), false)).toBe(true);
  });

  test("not when the keychain can't save, until the User accepts plain text", () => {
    expect(storageReady(status(false), false)).toBe(false);
  });
});
