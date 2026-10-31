/**
 * A picture the web engine can't read, as macOS's HEIC, turned into a PNG by
 * the computer's own decoder: sips on macOS, libheif's `heif-convert` on a
 * Linux computer that has it. Windows' imaging has no command-line converter,
 * so there nothing is read. The file goes through a temporary file of this
 * process's own, never the User's, which is removed whatever happens.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 50 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The command that reads one of these pictures into `outPath`, or null where this computer has none. */
function converter(): ((from: string, to: string) => string[]) | null {
  if (process.platform === "darwin") {
    return (from, to) => ["-s", "format", "png", from, "--out", to];
  }
  if (process.platform === "linux") return (from, to) => [from, to];
  return null;
}

const command = () => (process.platform === "darwin" ? "sips" : "heif-convert");

function run(program: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: "ignore", timeout: TIMEOUT_MS });
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`${program} ended with code ${code ?? "none"}.`));
    });
  });
}

/**
 * `bytes` as a PNG of this computer's own decoder, or null where it has none
 * or can't read them. Null never fails the app: the picture says it can't be read.
 */
export async function decodePictureToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  const args = converter();
  if (!args || bytes.length === 0 || bytes.length > MAX_BYTES) return null;
  const folder = join(tmpdir(), `incarnamind-picture-${randomUUID()}`);
  const from = join(folder, "picture");
  const to = join(folder, "picture.png");
  try {
    // The picture is the User's: only this account reads the folder and the file, while they last.
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(from, bytes, { mode: 0o600 });
    await run(command(), args(from, to));
    const png = new Uint8Array(await readFile(to));
    if (png.length === 0 || png.length > MAX_BYTES) return null;
    return PNG.every((byte, at) => png[at] === byte) ? png : null;
  } catch (error) {
    console.warn("A picture couldn't be read by this computer's own decoder.", error);
    return null;
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
