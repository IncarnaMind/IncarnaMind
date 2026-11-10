import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { assertTestBuild } from "../../e2e/testBuild";

const checkouts: string[] = [];

function checkoutBuiltAs(main: string | null): string {
  const checkout = mkdtempSync(join(tmpdir(), "incarnamind-test-build-"));
  checkouts.push(checkout);
  if (main !== null) {
    mkdirSync(join(checkout, "out", "main"), { recursive: true });
    writeFileSync(join(checkout, "out", "main", "index.js"), main);
  }
  return checkout;
}

afterEach(() => {
  for (const checkout of checkouts.splice(0)) rmSync(checkout, { recursive: true, force: true });
});

const NOT_A_TEST_BUILD =
  /is not a test build, so the app would use the real microphone and the real models\. Build it first: npx electron-vite build --mode test$/;

test("a build that reads the fake microphone and the fake transcriber may be launched", () => {
  const checkout = checkoutBuiltAs(
    'if (process.env.INCARNAMIND_TEST_AUDIO === "fake") fake();\nif (process.env.INCARNAMIND_TEST_TRANSCRIBER === "fake") fake();\n',
  );
  expect(() => assertTestBuild(checkout)).not.toThrow();
});

test("an ordinary build, which reads neither fake, is refused with the command that builds a test one", () => {
  const checkout = checkoutBuiltAs("createElectronAudioCapture();\n");
  expect(() => assertTestBuild(checkout)).toThrow(NOT_A_TEST_BUILD);
});

test("an ordinary build that only names the fakes in a comment is refused", () => {
  const checkout = checkoutBuiltAs(
    "// INCARNAMIND_TEST_AUDIO=fake and INCARNAMIND_TEST_TRANSCRIBER=fake are for tests\ncreateElectronAudioCapture();\n",
  );
  expect(() => assertTestBuild(checkout)).toThrow(NOT_A_TEST_BUILD);
});

test("a build that reads only one of the fakes is refused", () => {
  const checkout = checkoutBuiltAs('if (process.env.INCARNAMIND_TEST_AUDIO === "fake") fake();\n');
  expect(() => assertTestBuild(checkout)).toThrow(NOT_A_TEST_BUILD);
});

test("a checkout that was never built is refused", () => {
  expect(() => assertTestBuild(checkoutBuiltAs(null))).toThrow(NOT_A_TEST_BUILD);
});
