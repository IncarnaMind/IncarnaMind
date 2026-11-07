import { describe, expect, test } from "vitest";
import type { ConnectorImportEntry } from "../../src/core/api";
import { importNeedsKeychain } from "../../src/renderer/src/components/connectors/importNeeds";

const entry = (fields: Partial<ConnectorImportEntry>): ConnectorImportEntry => ({
  name: "Tides",
  command: null,
  args: [],
  env: [],
  url: "https://tides.example.test/mcp",
  action: "add",
  ...fields,
});

describe("Whether importing Connectors needs the keychain (#2025)", () => {
  test("a header that only names an environment variable stores nothing, so it needs none", () => {
    expect(
      importNeedsKeychain([
        entry({
          headers: ["Authorization"],
          placeholders: [{ header: "Authorization", variable: "TIDE_KEY" }],
        }),
      ]),
    ).toBe(false);
  });

  test("a header with a value of its own needs the keychain", () => {
    expect(
      importNeedsKeychain([
        entry({
          headers: ["Authorization", "X-Tenant-Key"],
          placeholders: [{ header: "Authorization", variable: "TIDE_KEY" }],
        }),
      ]),
    ).toBe(true);
  });

  test("an environment variable's value needs the keychain", () => {
    expect(importNeedsKeychain([entry({ env: ["TIDE_KEY"] })])).toBe(true);
  });
});
