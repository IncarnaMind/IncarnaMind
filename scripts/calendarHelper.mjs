// Builds IncarnaMind's Mac calendar helper (native/calendar-helper/main.swift, #190) with the Swift
// compiler of Xcode's command line tools. The packager runs it after laying the macOS app out and
// before signing (scripts/afterPack.mjs), so the helper is signed and notarized with the app.
// For development: npm run calendar-helper, which builds into DEV_HELPER, where the app looks.
// Off macOS it builds nothing: only the Mac has the Calendar app's EventKit.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HELPER_SOURCE = join(ROOT, "native", "calendar-helper", "main.swift");
export const DEV_HELPER = join(ROOT, "native", "calendar-helper", ".build", "calendar-helper");
/** Where the app finds the helper: beside app.asar, in Contents/Resources. */
export const HELPER_NAME = "calendar-helper";

/** Compiles the helper to `output`; false off macOS, where nothing is built. */
export async function buildCalendarHelper(output = DEV_HELPER, platform = process.platform) {
	if (platform !== "darwin") return false;
	await mkdir(dirname(output), { recursive: true });
	// The app runs on Apple silicon only (#2199), and on macOS 12 and later as Electron does.
	await promisify(execFile)("swiftc", [
		"-O",
		"-target",
		"arm64-apple-macos12.0",
		"-o",
		output,
		HELPER_SOURCE,
	]);
	return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const output = process.argv[2] ?? DEV_HELPER;
	if (await buildCalendarHelper(output)) console.log(`Built the calendar helper at ${output}.`);
	else console.log("The calendar helper is built only on macOS.");
}
