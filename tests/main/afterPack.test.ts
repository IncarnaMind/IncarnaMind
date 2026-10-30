import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import afterPack, { speechRuntimes } from "../../scripts/afterPack.mjs";

let app = "";
let modules = "";

const speechPackage = (arch: string) => join(modules, `sherpa-onnx-win-${arch}`);
const appRuntime = (arch: string) =>
  join(modules, "onnxruntime-node", "bin", "napi-v6", "win32", arch, "onnxruntime.dll");

async function lay(arch: string) {
  await mkdir(speechPackage(arch), { recursive: true });
  await writeFile(join(speechPackage(arch), "onnxruntime.dll"), `speech ${arch} 1.28.2`);
  await writeFile(join(speechPackage(arch), "onnxruntime_providers_shared.dll"), "shared 1.28.2");
  await writeFile(join(speechPackage(arch), "sherpa-onnx.node"), "addon");
  await mkdir(join(modules, "onnxruntime-node", "bin", "napi-v6", "win32", arch), {
    recursive: true,
  });
  await writeFile(appRuntime(arch), `app ${arch} 1.30.0`);
}

beforeEach(async () => {
  app = await mkdtemp(join(tmpdir(), "incarnamind-afterpack-"));
  modules = join(app, "resources", "app.asar.unpacked", "node_modules");
  await mkdir(modules, { recursive: true });
});

afterEach(() => rm(app, { recursive: true, force: true }));

describe("the packager's step for the Windows speech package", () => {
  it("puts the app's ONNX Runtime library in place of the speech package's and drops its provider loader", async () => {
    await lay("x64");
    await afterPack({ electronPlatformName: "win32", appOutDir: app });
    expect(await readFile(join(speechPackage("x64"), "onnxruntime.dll"), "utf8")).toBe(
      "app x64 1.30.0",
    );
    expect(existsSync(join(speechPackage("x64"), "onnxruntime_providers_shared.dll"))).toBe(false);
    expect(await readFile(join(speechPackage("x64"), "sherpa-onnx.node"), "utf8")).toBe("addon");
    expect(await readFile(appRuntime("x64"), "utf8")).toBe("app x64 1.30.0");
  });

  it("matches each architecture's speech package with that architecture's library", async () => {
    await lay("x64");
    await lay("arm64");
    await afterPack({ electronPlatformName: "win32", appOutDir: app });
    expect(await readFile(join(speechPackage("x64"), "onnxruntime.dll"), "utf8")).toBe(
      "app x64 1.30.0",
    );
    expect(await readFile(join(speechPackage("arm64"), "onnxruntime.dll"), "utf8")).toBe(
      "app arm64 1.30.0",
    );
  });

  it("leaves a macOS or Linux app alone", async () => {
    await lay("x64");
    for (const electronPlatformName of ["darwin", "linux"]) {
      await afterPack({ electronPlatformName, appOutDir: app });
    }
    expect(await readFile(join(speechPackage("x64"), "onnxruntime.dll"), "utf8")).toBe(
      "speech x64 1.28.2",
    );
    expect(existsSync(join(speechPackage("x64"), "onnxruntime_providers_shared.dll"))).toBe(true);
  });

  it("stops the build when the app's library isn't there, rather than ship the speech package's", async () => {
    await lay("x64");
    await rm(appRuntime("x64"));
    await expect(afterPack({ electronPlatformName: "win32", appOutDir: app })).rejects.toThrow();
  });

  it("stops the build when the app has no Windows speech package to give it to", async () => {
    await expect(afterPack({ electronPlatformName: "win32", appOutDir: app })).rejects.toThrow(
      /no Windows speech package/,
    );
  });

  it("names both libraries of each speech package for the build's own check", async () => {
    await lay("x64");
    expect(await speechRuntimes(modules)).toEqual([
      {
        speech: join(speechPackage("x64"), "onnxruntime.dll"),
        sharedProviders: join(speechPackage("x64"), "onnxruntime_providers_shared.dll"),
        app: appRuntime("x64"),
      },
    ]);
  });
});
