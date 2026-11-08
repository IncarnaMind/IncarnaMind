/**
 * Writes the app icon's files in build/icon/ from its SVG drawings in build/icon/svg/:
 * `npm run icons`. It needs macOS with Xcode 26 (iconutil writes the .icns, actool compiles
 * the Icon Composer icon) and Playwright's Chromium (`npx playwright install chromium`),
 * which draws the SVGs. Packaging uses the files it writes and needs none of these.
 *
 * From 32 px up the icon is the full IM; below 32 px the I drops out and the checked M
 * remains (DESIGN.md). The 16 and 32 px images come from their own drawings, never from
 * scaling the master down.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";

const ICON = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon");
const svgPath = (name: string) => join(ICON, "svg", `${name}.svg`);

const macDrawing = (size: number) =>
  size <= 16 ? "mac-16-light" : size <= 32 ? "mac-32-light" : "mac-light";
const roundedDrawing = (size: number) =>
  size < 32 ? "small-16-light" : size === 32 ? "small-32-light" : "rounded-light";

const ICONSET: ReadonlyArray<readonly [string, number]> = [
  ["16x16", 16],
  ["16x16@2x", 32],
  ["32x32", 32],
  ["32x32@2x", 64],
  ["128x128", 128],
  ["128x128@2x", 256],
  ["256x256", 256],
  ["256x256@2x", 512],
  ["512x512", 512],
  ["512x512@2x", 1024],
];
const WINDOWS_SIZES = [16, 24, 32, 48, 64, 256];
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const TRAY = [
  ["tray", "trayTemplate"],
  ["tray-recording", "trayRecordingTemplate"],
] as const;

interface Drawn {
  size: number;
  png: Buffer;
  rgba: Buffer;
}

const DRAW = `async ({ svg, size }) => {
  const image = new Image();
  image.src = "data:image/svg+xml;base64," + btoa(svg);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, size, size).data;
  let binary = "";
  for (let at = 0; at < pixels.length; at += 0x8000) {
    binary += String.fromCharCode(...pixels.subarray(at, at + 0x8000));
  }
  return { png: canvas.toDataURL("image/png").split(",")[1], rgba: btoa(binary) };
}`;

/**
 * Draws an SVG at `size` px. Its root is given that size, so Chromium draws the vectors at it
 * rather than scaling a bitmap.
 */
async function draw(page: Page, name: string, size: number): Promise<Drawn> {
  const svg = readFileSync(svgPath(name), "utf8").replace(
    /^<svg([^>]*?) width="[\d.]+" height="[\d.]+"/,
    `<svg$1 width="${size}" height="${size}"`,
  );
  const drawn = await page.evaluate<{ png: string; rgba: string }>(
    `(${DRAW})(${JSON.stringify({ svg, size })})`,
  );
  return { size, png: Buffer.from(drawn.png, "base64"), rgba: Buffer.from(drawn.rgba, "base64") };
}

/** A 32-bit BMP for an .ico: bottom-up BGRA rows, then a 1-bit mask set where a pixel is clear. */
function bmp({ size, rgba }: Drawn): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const pixel = rgba.readUInt32BE((y * size + x) * 4);
      const alpha = pixel & 0xff;
      pixels.writeUInt32LE(((alpha << 24) | (pixel >>> 8)) >>> 0, (row * size + x) * 4);
      if (alpha === 0) {
        const at = row * maskStride + (x >> 3);
        mask.writeUInt8(mask.readUInt8(at) | (0x80 >> (x & 7)), at);
      }
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

/** An .ico as Windows' own tools write one: a BMP for each size under 256 px, and a PNG at 256. */
function ico(images: Drawn[]): Buffer {
  const entries = images.map((image) => (image.size >= 256 ? image.png : bmp(image)));
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  entries.forEach((entry, index) => {
    const at = 6 + 16 * index;
    const size = images[index]?.size ?? 0;
    directory.writeUInt8(size % 256, at);
    directory.writeUInt8(size % 256, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.length;
  });
  return Buffer.concat([directory, ...entries]);
}

/** The plate's colour in an SVG drawing (its first fill), as Icon Composer writes a colour. */
function plateColour(name: string): string {
  const hex = /fill="#([0-9A-Fa-f]{6})"/.exec(readFileSync(svgPath(name), "utf8"))?.[1];
  if (!hex) throw new Error(`No plate colour in ${svgPath(name)}`);
  const channels = [0, 2, 4].map((at) =>
    (Number.parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(5),
  );
  return `srgb:${channels.join(",")},1.00000`;
}

type Point = readonly [number, number];

/** The points of each subpath of an SVG path drawn with absolute M, L, H and V commands. */
function polylines(data: string): Point[][] {
  const lines: Point[][] = [];
  let [x, y] = [0, 0];
  for (const [, command = "", args = ""] of data.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const numbers = args
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const [a = Number.NaN, b = Number.NaN] = numbers;
    const expected = command === "M" || command === "L" ? 2 : 1;
    if (!"MLHV".includes(command) || numbers.length !== expected || numbers.some(Number.isNaN)) {
      throw new Error(`Can't read "${command}${args}" in a glyph's path`);
    }
    if (command === "M" || command === "L") [x, y] = [a, b];
    else if (command === "H") x = a;
    else y = a;
    if (command === "M") lines.push([]);
    lines.at(-1)?.push([x, y]);
  }
  return lines;
}

/** A filled line with round ends: what a round-capped stroke of width 2 × radius draws. */
function capsule([fromX, fromY]: Point, [toX, toY]: Point, radius: number): string {
  const length = Math.hypot(toX - fromX, toY - fromY);
  const [normalX, normalY] = [((fromY - toY) / length) * radius, ((toX - fromX) / length) * radius];
  const point = (x: number, y: number) => `${Number(x.toFixed(3))} ${Number(y.toFixed(3))}`;
  const arc = `A${radius} ${radius} 0 0 0`;
  return [
    `M${point(fromX + normalX, fromY + normalY)}`,
    `L${point(toX + normalX, toY + normalY)}`,
    `${arc} ${point(toX - normalX, toY - normalY)}`,
    `L${point(fromX - normalX, fromY - normalY)}`,
    `${arc} ${point(fromX + normalX, fromY + normalY)}Z`,
  ].join("");
}

/**
 * Icon Composer draws every stroke's ends square, whatever `stroke-linecap` says, which cuts
 * the round ends off the stems. So each stroked path becomes filled capsules, one per
 * segment, which together draw the same round caps and joins.
 */
function strokesToFills(svg: string): string {
  return svg.replace(
    /<path d="([^"]+)" fill="none" stroke="(#[0-9A-Fa-f]{6})" stroke-width="([\d.]+)"[^>]*\/>/g,
    (_, data: string, colour: string, width: string) => {
      const capsules = polylines(data).flatMap((line) =>
        line.slice(1).map((to, index) => capsule(line[index] ?? to, to, Number(width) / 2)),
      );
      return `<path d="${capsules.join("")}" fill="${colour}"/>`;
    },
  );
}

/**
 * macOS 26's icon, in Default and Dark: the glyph on the plate's colour, which the system
 * cuts to its own shape and edges with glass. The glyph stays flat, opaque and unshadowed,
 * as the drawings have it.
 */
function writeIconComposer(bundle: string): void {
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(join(bundle, "Assets"), { recursive: true });
  for (const appearance of ["light", "dark"]) {
    writeFileSync(
      join(bundle, "Assets", `glyph-${appearance}.svg`),
      strokesToFills(readFileSync(svgPath(`icon-composer-glyph-${appearance}`), "utf8")),
    );
  }
  const icon = {
    "fill-specializations": [
      { value: { solid: plateColour("mac-light") } },
      { appearance: "dark", value: { solid: plateColour("mac-dark") } },
    ],
    groups: [
      {
        layers: [
          {
            name: "Glyph",
            "image-name-specializations": [
              { value: "glyph-light.svg" },
              { appearance: "dark", value: "glyph-dark.svg" },
            ],
          },
        ],
        specular: false,
        shadow: { kind: "none", opacity: 0 },
        translucency: { enabled: false, value: 0 },
      },
    ],
    "supported-platforms": { squares: "shared" },
  };
  writeFileSync(join(bundle, "icon.json"), `${JSON.stringify(icon, null, 2)}\n`);
}

if (process.platform !== "darwin") {
  throw new Error(
    "npm run icons needs macOS: iconutil writes the .icns and Xcode 26's actool the Assets.car.",
  );
}

const scratch = mkdtempSync(join(tmpdir(), "incarnamind-icons-"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  const iconset = join(scratch, "icon.iconset");
  mkdirSync(iconset);
  for (const [name, size] of ICONSET) {
    writeFileSync(
      join(iconset, `icon_${name}.png`),
      (await draw(page, macDrawing(size), size)).png,
    );
  }
  execFileSync("iconutil", ["--convert", "icns", "--output", join(ICON, "icon.icns"), iconset]);

  for (const appearance of ["light", "dark"]) {
    writeFileSync(
      join(ICON, `dock-${appearance}.png`),
      (await draw(page, `mac-${appearance}`, 512)).png,
    );
  }

  const windows: Drawn[] = [];
  for (const size of WINDOWS_SIZES) windows.push(await draw(page, roundedDrawing(size), size));
  writeFileSync(join(ICON, "icon.ico"), ico(windows));

  const linux = join(ICON, "png");
  rmSync(linux, { recursive: true, force: true });
  mkdirSync(linux);
  for (const size of LINUX_SIZES) {
    writeFileSync(
      join(linux, `${size}x${size}.png`),
      (await draw(page, roundedDrawing(size), size)).png,
    );
  }

  // The menu bar's icon (#189): template images, which macOS colours for the bar.
  const tray = join(ICON, "tray");
  mkdirSync(tray, { recursive: true });
  for (const [drawing, file] of TRAY) {
    for (const [scale, suffix] of [
      [1, ""],
      [2, "@2x"],
    ] as const) {
      writeFileSync(join(tray, `${file}${suffix}.png`), (await draw(page, drawing, 16 * scale)).png);
    }
  }

  const bundle = join(ICON, "AppIcon.icon");
  writeIconComposer(bundle);
  const compiled = join(scratch, "compiled");
  mkdirSync(compiled);
  // The arguments electron-builder compiles a `.icon` with, so the result is the one it would make.
  execFileSync(
    "xcrun",
    [
      "actool",
      bundle,
      "--compile",
      compiled,
      "--output-format",
      "human-readable-text",
      "--notices",
      "--warnings",
      "--output-partial-info-plist",
      join(compiled, "assetcatalog_generated_info.plist"),
      "--app-icon",
      "AppIcon",
      "--include-all-app-icons",
      "--enable-on-demand-resources",
      "NO",
      "--development-region",
      "en",
      "--target-device",
      "mac",
      "--minimum-deployment-target",
      "26.0",
      "--platform",
      "macosx",
    ],
    { stdio: "inherit" },
  );
  cpSync(join(compiled, "Assets.car"), join(ICON, "Assets.car"));
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
