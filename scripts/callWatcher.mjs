// Builds IncarnaMind's call watcher on macOS (native/callWatcher/mac.m, #208) with the C compiler of
// Xcode's command line tools. The packager runs it after laying the macOS app out and before
// signing (scripts/afterPack.mjs), as it does the calendar helper, so the watcher is signed and
// notarized with the app. For development: npm run call-watcher, which builds into DEV_WATCHER,
// where the app looks. Off macOS it builds nothing: Windows and Linux use the system's own tools.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WATCHER_SOURCE = join(ROOT, "native", "callWatcher", "mac.m");
/** Where the app finds the watcher: beside app.asar, in Contents/Resources. */
export const WATCHER_NAME = "call-watcher";
export const DEV_WATCHER = join(ROOT, "native", "callWatcher", ".build", WATCHER_NAME);

/** Compiles the watcher to `output`; false off macOS, where nothing is built. */
export async function buildCallWatcher(output = DEV_WATCHER, platform = process.platform) {
	if (platform !== "darwin") return false;
	await mkdir(dirname(output), { recursive: true });
	// The app runs on Apple silicon only (#2199), and on macOS 12 and later as Electron does.
	await promisify(execFile)("xcrun", [
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
		output,
		WATCHER_SOURCE,
	]);
	return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const output = process.argv[2] ?? DEV_WATCHER;
	if (await buildCallWatcher(output)) console.log(`Built the call watcher at ${output}.`);
	else console.log("The call watcher is built only on macOS.");
}
