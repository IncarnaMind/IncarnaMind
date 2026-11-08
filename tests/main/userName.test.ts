import { afterEach, expect, test, vi } from "vitest";
import type { Logger } from "../../src/core/adapters";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

/** The module reads its name once: each case starts from an unread one, with those fakes. */
async function systemUserName() {
  vi.resetModules();
  return (await import("../../src/main/userName")).systemUserName;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:os");
  vi.resetModules();
  vi.clearAllMocks();
});

test("a test launch names Test Author, never the account's (#2762)", async () => {
  vi.stubEnv("INCARNAMIND_TEST_HOOKS", "1");
  const execFileSync = vi.fn(() => "Priya Raman\n");
  vi.doMock("node:child_process", () => ({ execFileSync }));
  const name = await systemUserName();

  expect(name(log)).toBe("Test Author");
  expect(execFileSync).not.toHaveBeenCalled();
});

test("outside a test launch, the full name macOS keeps, else the account's name", async () => {
  vi.stubEnv("INCARNAMIND_TEST_HOOKS", "0");
  vi.doMock("node:child_process", () => ({ execFileSync: () => "Priya Raman\n" }));
  vi.doMock("node:os", () => ({ userInfo: () => ({ username: "priya" }) }));
  const name = await systemUserName();

  expect(name(log)).toBe(process.platform === "darwin" ? "Priya Raman" : "priya");
});

test("else the account's name, when the full name can't be read", async () => {
  vi.stubEnv("INCARNAMIND_TEST_HOOKS", "0");
  vi.doMock("node:child_process", () => ({
    execFileSync: () => {
      throw new Error("id: no full name");
    },
  }));
  vi.doMock("node:os", () => ({ userInfo: () => ({ username: "priya" }) }));
  const name = await systemUserName();

  expect(name(log)).toBe("priya");
});
