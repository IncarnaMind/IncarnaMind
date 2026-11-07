/**
 * The update check carries no identifier of the install (#2557). electron-updater
 * keeps a random one in `.updaterId` and sends it as `x-user-staging-id`, so this
 * runs the app's update check against a fake transport and watches every request leave.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  folder: "",
  data: "",
  requests: [] as RequestOptions[],
}));

vi.mock("electron-updater", async () => {
  const { NsisUpdater } = await import("electron-updater/out/NsisUpdater");
  const { UpdaterAppFixture } = await import("../helpers/updaterSdk");
  const app = new UpdaterAppFixture(fixture.folder);
  fixture.data = app.userDataPath;
  return { autoUpdater: new NsisUpdater(null, app) };
});

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/IncarnaMind/IncarnaMind/releases/tag/v1.2.3"/>
    <title>1.2.3</title>
    <content>A newer version.</content>
  </entry>
</feed>`;

const CHANNEL = `version: 1.2.3
files:
  - url: IncarnaMind-1.2.3.dmg
    sha512: aGVsbG8=
    size: 10
path: IncarnaMind-1.2.3.dmg
sha512: aGVsbG8=
releaseDate: "2026-01-01T00:00:00.000Z"
`;

function fakeTransport() {
  return {
    async request(options: RequestOptions): Promise<string> {
      fixture.requests.push(options);
      const path = String(options.path);
      if (path.endsWith(".atom")) return FEED;
      if (path.endsWith("/latest")) return JSON.stringify({ tag_name: "v1.2.3" });
      if (path.endsWith(".yml")) return CHANNEL;
      throw new Error(`Unexpected update request: ${path}`);
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  fixture.requests = [];
  fixture.folder = mkdtempSync(join(tmpdir(), "incarnamind-update-check-"));
  mkdirSync(join(fixture.folder, "data"));
  writeFileSync(
    join(fixture.folder, "app-update.yml"),
    "provider: github\nowner: IncarnaMind\nrepo: IncarnaMind\n",
  );
});

afterEach(() => {
  rmSync(fixture.folder, { recursive: true, force: true });
});

async function check() {
  const { autoUpdater } = await import("../../src/main/autoUpdater");
  autoUpdater.logger = null;
  autoUpdater.autoDownload = false;
  Object.assign(autoUpdater, { httpExecutor: fakeTransport() });
  return autoUpdater.checkForUpdates();
}

test("the update check reads a version without sending an install identifier", async () => {
  const { updateCheckSendsNoInstallId } = await import("../../src/main/autoUpdater");
  expect(updateCheckSendsNoInstallId).toBe(true);
  const result = await check();
  expect(result?.isUpdateAvailable).toBe(true);
  expect(result?.updateInfo.version).toBe("1.2.3");
  expect(fixture.requests.map((request) => String(request.path))).toEqual(
    expect.arrayContaining([
      expect.stringContaining("/releases.atom"),
      expect.stringContaining("/releases/latest"),
      expect.stringContaining(".yml"),
    ]),
  );
  const sent = fixture.requests.flatMap((request) =>
    Object.keys(request.headers ?? {}).map((name) => name.toLowerCase()),
  );
  expect(sent).not.toContain("x-user-staging-id");
  expect(existsSync(join(fixture.data, ".updaterId"))).toBe(false);
});

test.each(["stagingUserIdPromise", "computeFinalHeaders"] as const)(
  "stripping the install ID fails closed when %s is missing",
  async (missing) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { stripInstallId } = await import("../../src/main/autoUpdater");
    const updater: Parameters<typeof stripInstallId>[0] = {
      stagingUserIdPromise: { value: Promise.resolve("old-install-id") },
      computeFinalHeaders: (headers) => headers,
    };
    if (missing === "stagingUserIdPromise") updater.stagingUserIdPromise = undefined;
    else updater.computeFinalHeaders = undefined;
    expect(stripInstallId(updater)).toBe(false);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("#2557");
  },
);
