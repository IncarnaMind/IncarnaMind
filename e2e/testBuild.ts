import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * What only a build made with `--mode test` reads: every other build drops the code that does.
 * Looked for as code, since a comment may name them in any build.
 */
const FAKES = ["process.env.INCARNAMIND_TEST_AUDIO", "process.env.INCARNAMIND_TEST_TRANSCRIBER"];

/**
 * Throws unless the app built in `checkout` is a test build. Any other build ignores the fakes a
 * launch asks for, so a Meeting would record with the real microphone and download the real speech
 * model (#2941).
 */
export function assertTestBuild(checkout = resolve(__dirname, "..")): void {
  const main = join(checkout, "out", "main", "index.js");
  const built = existsSync(main) ? readFileSync(main, "utf8") : "";
  if (FAKES.every((fake) => built.includes(fake))) return;
  throw new Error(
    `${join(checkout, "out")} is not a test build, so the app would use the real microphone and the real models. Build it first: npx electron-vite build --mode test`,
  );
}
