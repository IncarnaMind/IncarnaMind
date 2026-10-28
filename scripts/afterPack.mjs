// Run by the packager after it lays an app out in dist/ (afterPack in electron-builder.yml).
//
// The Windows speech package ships its own onnxruntime.dll, 1.28.2, beside its addon, and the addon
// imports it by name. That copy writes usage events to Windows' diagnostic data and reads no
// opt-out, while the app's other engines load onnxruntime-node's 1.30 library, which the engine
// processes' environment keeps quiet (src/main/engineEnvironment.ts). So the speech package gets
// that library in its place: ONNX Runtime's C API is backward compatible, so an addon built for
// 1.28 runs on 1.30, and the app carries one runtime version (#2152).
import { copyFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

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

/** Puts the app's ONNX Runtime library in every Windows speech package of the unpacked app. */
export async function useAppRuntimeForSpeech(modules) {
	const runtimes = await speechRuntimes(modules);
	if (runtimes.length === 0) throw new Error(`${modules} has no Windows speech package.`);
	for (const { speech, sharedProviders, app } of runtimes) {
		await copyFile(app, speech);
		await rm(sharedProviders, { force: true });
	}
}

export default async function afterPack(context) {
	if (context.electronPlatformName !== "win32") return;
	await useAppRuntimeForSpeech(
		join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules"),
	);
}
