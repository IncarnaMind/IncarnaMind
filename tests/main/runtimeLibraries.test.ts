import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(
  new URL("../../node_modules/onnxruntime-node/bin/napi-v6", import.meta.url),
);

/** The switch each platform's library reads (src/main/engineProcess.ts). */
const SWITCH: Record<string, string> = {
  darwin: "ORT_DISABLE_TELEMETRY",
  linux: "ORT_DISABLE_TELEMETRY",
  win32: "ORT_RUNNING_UNIT_TESTS",
};

const libraries = readdirSync(BIN).flatMap((platform) =>
  readdirSync(join(BIN, platform)).flatMap((arch) =>
    readdirSync(join(BIN, platform, arch))
      .filter((file) => /^(libonnxruntime.*\.(dylib|so.*)|onnxruntime\.dll)$/.test(file))
      .map((file) => ({
        platform,
        path: join(BIN, platform, arch, file),
        name: `${platform}/${arch}/${file}`,
      })),
  ),
);

describe("the ONNX Runtime libraries onnxruntime-node ships", () => {
  it("cover every platform the app is built for", () => {
    expect([...new Set(libraries.map((library) => library.platform))].sort()).toEqual([
      "darwin",
      "linux",
      "win32",
    ]);
  });

  it.each(libraries)("$name still reads the switch that turns its telemetry off", (library) => {
    const switchName = SWITCH[library.platform];
    expect(switchName).toBeDefined();
    expect(readFileSync(library.path).includes(Buffer.from(switchName as string))).toBe(true);
  });
});
