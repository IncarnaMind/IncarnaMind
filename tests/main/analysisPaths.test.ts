import { join, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { devServerUrl, pageFile, sandboxOff } from "../../src/main/analysisPaths";

/*
 * What the analysis window's scheme serves (ADR-0023): only its own page and assets, resolved
 * before they are checked, and in development only paths on the dev server; and whether the app
 * runs with Chromium's sandbox off, when no Analysis may run.
 */

const ROOT = join(sep, "app", "out", "renderer");

describe("the analysis window's files", () => {
  test("its page and its assets are served, from the built renderer", () => {
    expect(pageFile(ROOT, "/analysis.html")).toBe(join(ROOT, "analysis.html"));
    expect(pageFile(ROOT, "/assets/page-1a2b.js")).toBe(join(ROOT, "assets", "page-1a2b.js"));
  });

  test("a path that leads out of assets once resolved is refused: the app's own page, or a file outside", () => {
    expect(pageFile(ROOT, "/assets/../index.html")).toBeNull();
    expect(pageFile(ROOT, "/assets/../../main/index.js")).toBeNull();
    expect(pageFile(ROOT, "/index.html")).toBeNull();
    expect(pageFile(ROOT, "/../../etc/hosts")).toBeNull();
  });

  test("in development, a path is fetched from the dev server, and one that names another host is refused", () => {
    const server = "http://localhost:5173";
    expect(devServerUrl("/analysis.html", server)).toBe("http://localhost:5173/analysis.html");
    expect(devServerUrl("/analysis/worker.ts?worker_file&type=module", server)).toBe(
      "http://localhost:5173/analysis/worker.ts?worker_file&type=module",
    );
    expect(devServerUrl("//127.0.0.1:9/leak?d=secret", server)).toBeNull();
    expect(devServerUrl("//evil.example/", server)).toBeNull();
  });

  test("the sandbox is off with --no-sandbox or ELECTRON_DISABLE_SANDBOX, and on otherwise", () => {
    const none = () => false;
    expect(sandboxOff((name) => name === "no-sandbox", {})).toBe(true);
    expect(sandboxOff(none, { ELECTRON_DISABLE_SANDBOX: "1" })).toBe(true);
    expect(sandboxOff(none, {})).toBe(false);
  });
});
