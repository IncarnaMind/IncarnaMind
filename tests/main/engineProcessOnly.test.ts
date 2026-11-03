import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const ALLOWED = join("src", "main", "engineProcess.ts");

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sources(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

// A lint rule can be relaxed by accident; this can't: every engine process starts through
// startEngineProcess, which turns off ONNX Runtime's telemetry (#2145). The word appears in a named,
// aliased, namespace, default, destructured or required use alike, and in a comment.
it("keeps utilityProcess in src/main/engineProcess.ts and nowhere else in src", () => {
  const uses = sources(join(root, "src"))
    .filter((file) => relative(root, file) !== ALLOWED)
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, at) =>
          /\butilityProcess\b/.test(line) ? [`${relative(root, file)}:${at + 1}`] : [],
        ),
    );
  expect(uses).toEqual([]);
});

it("finds the one place that starts them", () => {
  expect(readFileSync(join(root, ALLOWED), "utf8")).toMatch(/\butilityProcess\.fork\(/);
});
