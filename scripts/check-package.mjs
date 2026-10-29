// Checks what electron-builder packed, after `npm run dist:dir` or `npm run dist`:
//   1. Every app.asar under dist/ holds only out/, node_modules/ and package.json at its
//      top level. Anything else (sources, tests, data, untracked files in the checkout)
//      means the `files` patterns in electron-builder.yml let the whole folder in.
//   2. Each app.asar and each installer is within its size budget.
//   3. Each app has the speech-to-text addon (#136) of its own platform and architecture, and no
//      other, unpacked beside app.asar. On Windows its ONNX Runtime library is the app's own, byte
//      for byte (#2152).
//   4. Each app has what Analyses run with (ADR-0023) in python/ beside app.asar, as
//      packages.json lists it.
//   5. macOS is Apple silicon only (#2199): no Intel app or installer, and latest-mac.yml, which
//      the auto-updater reads, offers only arm64 files.
// Usage: node scripts/check-package.mjs [dist-folder]   (default: dist)
// Exit code 1 when a check fails.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { listPackage } from "@electron/asar";
import { speechRuntimes } from "./afterPack.mjs";

const ALLOWED_TOP_LEVEL = new Set(["out", "node_modules", "package.json"]);

// Set from the fixed macOS arm64 build (app.asar 130.8 MB) plus about 20%. The asar holds
// JavaScript and pure-JS dependencies; the native libraries are unpacked beside it.
const MAX_ASAR_BYTES = 157_000_000;
// The largest installer, the Linux AppImage with what Analyses run with (231.3 MB, ADR-0023),
// plus about 14 MB: the next real growth trips it, to be argued for. The macOS and Windows
// installers are checked against the same limit.
const MAX_INSTALLER_BYTES = 245_000_000;
// The .deb of the Linux x64 build (170 MB before Analyses, which add about 14 MB) plus about 15 MB.
const MAX_DEB_BYTES = 199_000_000;

const distDir = resolve(process.argv[2] ?? "dist");
const INSTALLER_EXT = /\.(dmg|zip|exe|AppImage|deb)$/;
/** An installer is at the top of dist/; win-unpacked/IncarnaMind.exe is the app itself. */
const isInstaller = (file) => dirname(file) === distDir && INSTALLER_EXT.test(file);

/** Every file under dir, except what is inside an app.asar.unpacked folder. */
function walk(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "app.asar.unpacked") continue;
			found.push(...walk(path));
		} else {
			found.push(path);
		}
	}
	return found;
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const failures = [];

let files;
try {
	files = walk(distDir);
} catch {
	console.error(`No packaged output at ${distDir}. Run npm run dist:dir first.`);
	process.exit(1);
}

const asars = files.filter((f) => f.endsWith("app.asar"));
if (asars.length === 0) {
	console.error(`No app.asar found under ${distDir}.`);
	process.exit(1);
}

for (const asar of asars) {
	const size = statSync(asar).size;
	const entries = listPackage(asar, { isPack: false });
	const topLevel = new Map();
	for (const entry of entries) {
		const name = entry.replace(/^[\\/]/, "").split(/[\\/]/)[0];
		if (name) topLevel.set(name, (topLevel.get(name) ?? 0) + 1);
	}
	const offenders = [...topLevel.keys()].filter((n) => !ALLOWED_TOP_LEVEL.has(n)).sort();
	console.log(`${asar}: ${mb(size)}, ${entries.length} entries`);
	if (offenders.length > 0) {
		failures.push(
			`${asar} holds files outside out/, node_modules/ and package.json: ${offenders.join(", ")}`,
		);
	}
	if (size > MAX_ASAR_BYTES) {
		failures.push(`${asar} is ${mb(size)}, over the ${mb(MAX_ASAR_BYTES)} budget`);
	}
}

/** The speech package each app should have, from the folder electron-builder put it in. */
function speechPackageFor(asar) {
	if (asar.includes(`${sep}mac-arm64${sep}`)) return "sherpa-onnx-darwin-arm64";
	if (asar.includes(`${sep}win-unpacked${sep}`)) return "sherpa-onnx-win-x64";
	if (asar.includes(`${sep}linux-unpacked${sep}`)) return "sherpa-onnx-linux-x64";
	if (asar.includes(`${sep}linux-arm64-unpacked${sep}`)) return "sherpa-onnx-linux-arm64";
	return null;
}

for (const asar of asars) {
	const expected = speechPackageFor(asar);
	const modules = join(`${asar}.unpacked`, "node_modules");
	let found = [];
	try {
		found = readdirSync(modules).filter((name) => /^sherpa-onnx-(darwin|linux|win)-/.test(name));
	} catch {
		// No unpacked node_modules at all: reported below.
	}
	if (expected && !existsSync(join(modules, expected, "sherpa-onnx.node"))) {
		failures.push(`${asar} has no ${expected}/sherpa-onnx.node unpacked beside it`);
	}
	const others = found.filter((name) => name !== expected);
	if (others.length > 0) {
		failures.push(`${asar} carries another platform's speech package: ${others.join(", ")}`);
	}
	if (expected === "sherpa-onnx-win-x64") {
		for (const { speech, sharedProviders, app } of await speechRuntimes(modules)) {
			if (!existsSync(speech) || !existsSync(app) || !readFileSync(speech).equals(readFileSync(app))) {
				failures.push(`${speech} isn't the app's own ONNX Runtime library (#2152)`);
			}
			if (existsSync(sharedProviders)) {
				failures.push(`${sharedProviders} is the speech package's, beside the app's runtime (#2152)`);
			}
		}
	}
}

for (const asar of asars) {
	const python = join(dirname(asar), "python");
	let listed = [];
	try {
		listed = JSON.parse(readFileSync(join(python, "packages.json"), "utf8")).packages.map(
			(each) => each.file,
		);
	} catch {
		failures.push(`${asar} has no python/packages.json beside it`);
		continue;
	}
	const pyodide = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"];
	const missing = [...pyodide, "pyodide-lock.json", ...listed].filter(
		(name) => !existsSync(join(python, name)),
	);
	if (missing.length > 0) {
		failures.push(`${asar} is missing Python files beside it: ${missing.join(", ")}`);
	}
}

for (const file of files.filter(isInstaller)) {
	const size = statSync(file).size;
	const budget = file.endsWith(".deb") ? MAX_DEB_BYTES : MAX_INSTALLER_BYTES;
	console.log(`${file}: ${mb(size)}`);
	if (size > budget) {
		failures.push(`${file} is ${mb(size)}, over the ${mb(budget)} installer budget`);
	}
}

const intelApps = asars.filter((asar) =>
	["mac", "mac-x64"].includes(relative(distDir, asar).split(sep)[0] ?? ""),
);
const intelInstallers = files
	.filter(isInstaller)
	.filter((file) => /-mac-(?!arm64\.)/.test(basename(file)));
for (const intel of [...intelApps, ...intelInstallers]) {
	failures.push(`${intel} is for Intel Macs, which aren't supported (#2199)`);
}
const macUpdates = join(distDir, "latest-mac.yml");
if (existsSync(macUpdates)) {
	const offered = [
		...readFileSync(macUpdates, "utf8").matchAll(/^\s*(?:-\s*)?(?:url|path):\s*(\S+)/gm),
	].map(([, file]) => file);
	const notArm = offered.filter((file) => !file.includes("-arm64."));
	if (offered.length === 0 || notArm.length > 0) {
		const listed = notArm.join(", ") || "none at all";
		failures.push(`latest-mac.yml offers files that aren't for Apple silicon: ${listed}`);
	}
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
}
console.log("Package contents and sizes are within bounds.");
