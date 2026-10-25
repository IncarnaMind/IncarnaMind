import { describe, expect, test } from "vitest";
import { type CrashReporter, InvalidInputError, type PrivacySettingsPatch } from "../../src/core";
import { createTempDataFolder, nextEvent, startCore } from "../helpers/core";

/** A crash reporter that records what the core asked of it. */
function fakeCrashReporter(): CrashReporter & { calls: boolean[] } {
  const calls: boolean[] = [];
  return {
    calls,
    setEnabled: (enabled) => {
      calls.push(enabled);
    },
  };
}

/** A model source with a file to download, as the real one has. */
const HUGGING_FACE_SOURCE = {
  baseUrl: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/",
  files: [{ path: "onnx/model_quantized.onnx", size: 1, sha256: "0".repeat(64) }],
};

const GITHUB_RELEASES = { id: "https://github.com", name: "GitHub Releases" };

/** Usage data in a copy built without an analytics project (see usageData.test.ts). */
const NO_USAGE_DATA = {
  available: false,
  enabled: false,
  testerBuild: false,
  asked: false,
  localMode: false,
};

describe("Crash reports", () => {
  test("are off by default, and a copy without a reporter doesn't offer them", async () => {
    const core = startCore(await createTempDataFolder());

    expect(await core.getPrivacySettings()).toEqual({
      crashReports: { available: false, enabled: false },
      automaticUpdateChecks: true,
      usageData: NO_USAGE_DATA,
    });
    await expect(core.updatePrivacySettings({ crashReports: true })).rejects.toThrow(
      InvalidInputError,
    );
    expect((await core.getPrivacySettings()).crashReports.enabled).toBe(false);
  });

  test("the reporter isn't started before the User opts in; opting out stops it at once", async () => {
    const reporter = fakeCrashReporter();
    const core = startCore(await createTempDataFolder(), { crashReporter: reporter });

    expect(await core.getPrivacySettings()).toMatchObject({
      crashReports: { available: true, enabled: false },
    });
    expect(reporter.calls).toEqual([]);

    const optedIn = nextEvent(core, "privacy.changed");
    const settings = await core.updatePrivacySettings({ crashReports: true });
    expect(settings.crashReports).toEqual({ available: true, enabled: true });
    expect(await optedIn).toEqual(settings);
    expect(reporter.calls).toEqual([true]);

    // Opting in again changes nothing.
    await core.updatePrivacySettings({ crashReports: true });
    expect(reporter.calls).toEqual([true]);

    const optedOut = core.updatePrivacySettings({ crashReports: false });
    // Stopped before the call even returns.
    expect(reporter.calls).toEqual([true, false]);
    expect((await optedOut).crashReports.enabled).toBe(false);
  });

  test("an opt-in is remembered: the reporter starts with the core", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir, { crashReporter: fakeCrashReporter() });
    await first.updatePrivacySettings({ crashReports: true });
    first.close();

    const reporter = fakeCrashReporter();
    const second = startCore(dataDir, { crashReporter: reporter });

    expect(reporter.calls).toEqual([true]);
    expect((await second.getPrivacySettings()).crashReports.enabled).toBe(true);
  });

  test("an opt-out is remembered: the reporter never starts", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir, { crashReporter: fakeCrashReporter() });
    await first.updatePrivacySettings({ crashReports: true });
    await first.updatePrivacySettings({ crashReports: false });
    first.close();

    const reporter = fakeCrashReporter();
    startCore(dataDir, { crashReporter: reporter });

    expect(reporter.calls).toEqual([]);
  });

  test("a copy that can't send crash reports doesn't, even if the User opted in with another", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir, { crashReporter: fakeCrashReporter() });
    await first.updatePrivacySettings({ crashReports: true });
    first.close();

    const second = startCore(dataDir);

    expect((await second.getPrivacySettings()).crashReports).toEqual({
      available: false,
      enabled: false,
    });
  });
});

describe("Privacy settings", () => {
  test("automatic update checks are on by default, and turning them off is remembered", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    expect((await first.getPrivacySettings()).automaticUpdateChecks).toBe(true);

    const changed = nextEvent(first, "privacy.changed");
    await first.updatePrivacySettings({ automaticUpdateChecks: false });
    expect((await changed).automaticUpdateChecks).toBe(false);
    first.close();

    const second = startCore(dataDir);
    expect((await second.getPrivacySettings()).automaticUpdateChecks).toBe(false);
    await second.updatePrivacySettings({ automaticUpdateChecks: true });
    expect((await second.getPrivacySettings()).automaticUpdateChecks).toBe(true);
  });

  test.each([
    ["an unknown setting", { analytics: true }],
    ["a value that isn't true or false", { automaticUpdateChecks: "no" }],
    ["something that isn't an object", "off"],
  ])("refuses %s", async (_, patch) => {
    const core = startCore(await createTempDataFolder(), { crashReporter: fakeCrashReporter() });

    await expect(
      core.updatePrivacySettings(patch as unknown as PrivacySettingsPatch),
    ).rejects.toThrow(InvalidInputError);
    expect(await core.getPrivacySettings()).toEqual({
      crashReports: { available: true, enabled: false },
      automaticUpdateChecks: true,
      usageData: NO_USAGE_DATA,
    });
  });
});

describe("Network traffic without User content", () => {
  test("lists the search model download, the other sources it may come from, and Ollama's model downloads", async () => {
    const core = startCore(await createTempDataFolder(), {
      embeddingModelSource: HUGGING_FACE_SOURCE,
    });

    expect(await core.listNetworkTraffic()).toEqual([
      {
        id: "embedding-model",
        service: { id: "https://huggingface.co", name: "Hugging Face" },
        enabled: true,
      },
      {
        id: "model-source-modelscope",
        service: { id: "https://www.modelscope.cn", name: "ModelScope" },
        enabled: true,
      },
      {
        id: "model-source-hf-mirror",
        service: { id: "https://hf-mirror.com", name: "hf-mirror.com" },
        enabled: true,
      },
      {
        id: "ollama-pull",
        service: { id: "https://registry.ollama.ai", name: "Ollama" },
        enabled: true,
      },
    ]);
  });

  test("a model with nothing to download makes no traffic, so it isn't listed", async () => {
    const core = startCore(await createTempDataFolder());

    expect((await core.listNetworkTraffic()).map((traffic) => traffic.id)).toEqual(["ollama-pull"]);
  });

  test("traffic a feature registers later is listed too, on or off as the User chose", async () => {
    const core = startCore(await createTempDataFolder());

    // The desktop app registers its update check this way.
    core.networkTraffic.register({
      id: "update-check",
      service: GITHUB_RELEASES,
      enabled: async () => (await core.getPrivacySettings()).automaticUpdateChecks,
    });
    expect(await core.listNetworkTraffic()).toContainEqual({
      id: "update-check",
      service: GITHUB_RELEASES,
      enabled: true,
    });

    await core.updatePrivacySettings({ automaticUpdateChecks: false });
    expect(await core.listNetworkTraffic()).toContainEqual({
      id: "update-check",
      service: GITHUB_RELEASES,
      enabled: false,
    });
  });

  test("registering an id again replaces it; an unknown id is refused", async () => {
    const core = startCore(await createTempDataFolder());
    const mirror = { id: "https://ollama.example.com", name: "Ollama mirror" };

    core.networkTraffic.register({ id: "ollama-pull", service: mirror });
    expect(await core.listNetworkTraffic()).toEqual([
      { id: "ollama-pull", service: mirror, enabled: true },
    ]);
    expect(() =>
      core.networkTraffic.register({
        id: "analytics" as "update-check",
        service: { id: "https://example.com", name: "Example" },
      }),
    ).toThrow(/Unknown network traffic/);
  });
});
