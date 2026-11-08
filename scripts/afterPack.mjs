// Run by the packager after it lays an app out in dist/ (afterPack in electron-builder.yml), before
// it signs the app.
//
// The macOS app gets the Mac calendar helper (#190) and the call watcher (#208), built here, in
// Contents/Resources: signing then covers them with the app's Developer ID and hardened runtime,
// and notarization with the app.
//
// The Windows speech package ships its own onnxruntime.dll, 1.28.2, beside its addon, and the addon
// imports it by name. That copy writes usage events to Windows' diagnostic data and reads no
// opt-out, while the app's other engines load onnxruntime-node's 1.30 library, which the engine
// processes' environment keeps quiet (src/main/engineEnvironment.ts). So the speech package gets
// that library in its place: ONNX Runtime's C API is backward compatible, so an addon built for
// 1.28 runs on 1.30, and the app carries one runtime version (#2152).
import { copyFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildCalendarHelper, HELPER_NAME } from "./calendarHelper.mjs";
import { buildCallWatcher, WATCHER_NAME } from "./callWatcher.mjs";

const RUNTIME = "onnxruntime.dll";
// 1.28's loader for execution providers the speech engine never asks for (it runs on the CPU);
// left beside the 1.30 core it would be the one mismatched file.
const SHARED_PROVIDERS = "onnxruntime_providers_shared.dll";

/**
 * The speech package's library and the app's library that replaces it, in each Windows
 * architecture's speech package under an unpacked node_modules folder.
 */
export async function speechRuntimes(modules) {
	const packages = (await readdir(modules)).filter((name) => /^sherpa-onnx-win-/.test(name));
	return packages.map((name) => ({
		speech: join(modules, name, RUNTIME),
		sharedProviders: join(modules, name, SHARED_PROVIDERS),
		app: join(
			modules,
			"onnxruntime-node",
			"bin",
			"napi-v6",
			"win32",
			name.replace("sherpa-onnx-win-", ""),
			RUNTIME,
		),
	}));
}

export async function useAppRuntimeForSpeech(modules) {
	const runtimes = await speechRuntimes(modules);
	if (runtimes.length === 0) throw new Error(`${modules} has no Windows speech package.`);
	for (const { speech, sharedProviders, app } of runtimes) {
		await copyFile(app, speech);
		await rm(sharedProviders, { force: true });
	}
}

/** A helper's place in a packed macOS app, beside app.asar: the calendar helper's by default. */
export function macHelperPath(appOutDir, productFilename, name = HELPER_NAME) {
	return join(appOutDir, `${productFilename}.app`, "Contents", "Resources", name);
}

export default async function afterPack(
	context,
	build = buildCalendarHelper,
	buildWatcher = buildCallWatcher,
) {
	if (context.electronPlatformName === "darwin") {
		const { productFilename } = context.packager.appInfo;
		const output = macHelperPath(context.appOutDir, productFilename);
		if (!(await build(output, "darwin"))) throw new Error(`The calendar helper wasn't built at ${output}.`);
		const watcher = macHelperPath(context.appOutDir, productFilename, WATCHER_NAME);
		if (!(await buildWatcher(watcher, "darwin"))) throw new Error(`The call watcher wasn't built at ${watcher}.`);
		return;
	}
	if (context.electronPlatformName !== "win32") return;
	await useAppRuntimeForSpeech(
		join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules"),
	);
}
