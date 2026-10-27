import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { buildPdf } from "../../tests/helpers/pdf";

const [latinFont, hanFont, output] = process.argv.slice(2);
if (!latinFont || !hanFont || !output)
  throw new Error("Give a Latin font file, a Chinese font file and an output folder.");
const out = resolve(output);
await mkdir(out, { recursive: true });
for (const [name, path] of [
  ["EvalLatin", latinFont],
  ["EvalHan", hanFont],
] as const)
  if (!GlobalFonts.registerFromPath(path, name))
    throw new Error("A fixture font could not be loaded.");
const revisions = [
  {
    revision: "A",
    date: "2026-10-01",
    status: "SUPERSEDED",
    chinese: "已被替代",
    policy: "LARCH-31",
    limit: "0.400",
    beads: ["0.125", "2", "0.250"],
    weights: ["0.050", "3", "0.150"],
  },
  {
    revision: "B",
    date: "2026-10-23",
    status: "CURRENT",
    chinese: "当前有效",
    policy: "LARCH-52",
    limit: "0.250",
    beads: ["0.075", "2", "0.150"],
    weights: ["0.050", "2", "0.100"],
  },
];
const pages = revisions.map((r) => [
  "Upright revision control",
  `Revision ${r.revision}`,
  `Date: ${r.date}`,
  `Status: ${r.status}`,
  `Policy: ${r.policy}`,
  `Maximum load: ${r.limit} kg`,
  `状态：${r.chinese}`,
  `最大载荷：${r.limit} 千克`,
  "Load worksheet",
  "Item                 Unit mass (kg)   Quantity   Subtotal (kg)",
  `Glass beads          ${r.beads[0]}              ${r.beads[1]}               ${r.beads[2]}`,
  `Control weights      ${r.weights[0]}              ${r.weights[1]}               ${r.weights[2]}`,
  `TOTAL                                                        ${r.limit} kg`,
]);
const scans = [];
for (const [index, lines] of pages.entries()) {
  const canvas = createCanvas(1654, 2339),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 1654, 2339);
  ctx.fillStyle = "#111";
  lines.forEach((line, i) => {
    ctx.font = `${i === 0 ? 42 : 32}px EvalLatin, EvalHan`;
    ctx.fillText(line, 130, 170 + i * 74);
  });
  const jpeg = canvas.toBuffer("image/jpeg", 96);
  await writeFile(join(out, `page-${index + 1}.jpg`), jpeg);
  scans.push({ scan: jpeg });
}
const raster = buildPdf(scans),
  text = buildPdf(
    pages.map((lines) => ({ printed: lines.map((line) => ({ text: line, size: 10 })) })),
  );
const manifest = [];
for (const [name, bytes] of [
  ["raster.pdf", raster],
  ["text.pdf", text],
] as const) {
  await writeFile(join(out, name), bytes);
  manifest.push({
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      regenerated: true,
      originalSha256: "004a6bf0246cbff804af4bd4bd1bd226bf4759299cc1445a151236fe08e3f10a",
      generator: "tests/helpers/pdf.ts",
      dpi: 200,
      revisions,
      pages,
      files: manifest,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(manifest));
