// Which notice entries (resources/notices/python.txt) cover each shared library inside the
// wheels Analyses run with (ADR-0023, ADR-0025). An extension module is its package's own code,
// unless it is listed here with a library compiled into it; any other shared library must be
// listed. scripts/check-package.mjs fails a build with one that isn't.
import { readFileSync } from "node:fs";

/** A shared library by its path in its wheel, and the entries that must credit it. */
export const NATIVE_CODE = [
	{ path: /^matplotlib\/ft2font\./, notices: ["matplotlib", "FreeType"] },
	{
		path: /^matplotlib\/(backends\/_backend_agg|_image|_path)\./,
		notices: ["matplotlib", "Anti-Grain Geometry"],
	},
	{ path: /^matplotlib\/_qhull\./, notices: ["matplotlib", "Qhull"] },
	{ path: /^PIL\/_imaging\./, notices: ["pillow", "IJG libjpeg", "libtiff", "zlib"] },
	{ path: /^PIL\/_imagingft\./, notices: ["pillow", "FreeType"] },
	{ path: /^PIL\/_webp\./, notices: ["pillow", "libwebp"] },
	{ path: /^scipy\.libs\/libopenblas\.so$/, notices: ["OpenBLAS", "LAPACK", "libf2c"] },
];

const EXTENSION_MODULE = /\.cpython-\d+-wasm32-emscripten\.so$/;

/** The entries that must credit the shared library at `path` in `wheel`'s package; null for one no rule covers. */
export function noticesFor(wheel, path) {
	const rule = NATIVE_CODE.find((each) => each.path.test(path));
	if (rule) return rule.notices;
	return EXTENSION_MODULE.test(path) ? [wheel] : null;
}

/** The names of the files in a zip archive (a wheel), from its central directory. */
export function zipNames(file) {
	const bytes = readFileSync(file);
	const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (end < 0) throw new Error(`${file} is not a zip archive`);
	const count = bytes.readUInt16LE(end + 10);
	let at = bytes.readUInt32LE(end + 16);
	const names = [];
	for (let index = 0; index < count; index++) {
		if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error(`${file}'s directory is damaged`);
		const nameLength = bytes.readUInt16LE(at + 28);
		const extraLength = bytes.readUInt16LE(at + 30);
		const commentLength = bytes.readUInt16LE(at + 32);
		names.push(bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8"));
		at += 46 + nameLength + extraLength + commentLength;
	}
	return names;
}

/** Whether `notice` has an entry for `name`: a line "- name …". */
export const hasEntry = (notice, name) =>
	notice.split("\n").some((line) => line.startsWith(`- ${name} `) || line.startsWith(`- ${name},`));
