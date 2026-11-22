import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WATCHER_SOURCE = join(ROOT, "native", "callWatcher", "mac.m");
/** Where the app finds the watcher: beside app.asar, in Contents/Resources. */
export const WATCHER_NAME = "call-watcher";
export const WINDOWS_WATCHER_NAME = "call-watcher.exe";
const BUILD = join(ROOT, "native", "callWatcher", ".build");
export const DEV_WATCHER = join(BUILD, WATCHER_NAME);
const DEV_WINDOWS_WATCHER = join(BUILD, WINDOWS_WATCHER_NAME);
const run = promisify(execFile);

async function buildWindowsWatcher(output) {
	const source = join(ROOT, "native", "callWatcher", "windows");
	const build = join(BUILD, "windows-x64");
	const { version } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
	await run("cmake", ["-S", source, "-B", build, "-A", "x64", `-DVERSION_DOTTED=${version.split("-")[0]}.0`]);
	await run("cmake", ["--build", build, "--config", "Release"]);
	await copyFile(join(build, "Release", WINDOWS_WATCHER_NAME), output);
}

/** With no output path, build where the development app looks for the watcher. */
export async function buildCallWatcher(output, platform = process.platform) {
	if (platform !== "darwin" && platform !== "win32") return false;
	const destination = output ?? (platform === "win32" ? DEV_WINDOWS_WATCHER : DEV_WATCHER);
	await mkdir(dirname(destination), { recursive: true });
	if (platform === "win32") {
		await buildWindowsWatcher(destination);
		return true;
	}
	// The app runs on Apple silicon only (#2199), and on macOS 12 and later as Electron does.
	await run("xcrun", [
		"clang",
		"-fobjc-arc",
		"-O2",
		"-Wall",
		"-Werror",
		"-target",
		"arm64-apple-macos12.0",
		"-framework",
		"AppKit",
		"-framework",
		"CoreAudio",
		"-framework",
		"Foundation",
		"-o",
		destination,
		WATCHER_SOURCE,
	]);
	return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const output = process.argv[2];
	if (await buildCallWatcher(output)) console.log(`Built the call watcher at ${output ?? (process.platform === "win32" ? DEV_WINDOWS_WATCHER : DEV_WATCHER)}.`);
	else console.log("The call watcher is built only on macOS and Windows.");
}
