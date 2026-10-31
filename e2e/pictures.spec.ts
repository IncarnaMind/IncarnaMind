import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  afterEditorFocus,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Pictures in a Note (#1937): a screenshot pasted, a photo dropped and made
 * small, a HEIC read by the computer's own decoder, the description the User
 * writes for one, and Undo. As a person does it, through the editor.
 */
let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** A picture of a size a person sees: a gradient, as a PNG, written without a library. */
function gradientPng(size = 64): Buffer {
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 3 + 1);
    rows[at] = 0;
    for (let x = 0; x < size; x++) {
      rows[at + 1 + x * 3] = (x * 4) % 256;
      rows[at + 2 + x * 3] = (y * 4) % 256;
      rows[at + 3 + x * 3] = 128;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Opens a Note with the cursor in it, in a window of a fixed size. */
async function startNote(language: "en" | "zh-CN" = "en", width = 1280) {
  const running = await launchApp(dataDir);
  const { app, window } = running;
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 700);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  await afterEditorFocus(window);
  return { ...running, editor };
}

/** A file on disk the window can be given, as a paste or a drop brings one. */
function writePicture(name: string, bytes: Buffer): string {
  const path = join(dataDir, name);
  writeFileSync(path, bytes);
  return path;
}

/** Gives the window these files, as a file input does, and takes it away again. */
async function loadFiles(window: Page, paths: string[]): Promise<void> {
  await window.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.dataset.testid = "picture-source";
    input.hidden = true;
    document.body.append(input);
  });
  await window.getByTestId("picture-source").setInputFiles(paths);
}

/** Pastes what was loaded where the cursor is. */
async function paste(window: Page): Promise<void> {
  await window.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="picture-source"]');
    const editor = document.querySelector('[data-testid="mind-editor"]');
    if (!input?.files || !editor) throw new Error("No files to paste, or no editor.");
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files)) transfer.items.add(file);
    editor.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
    input.remove();
  });
}

/** The kept picture in the editor: drawn size and the data URL it keeps. */
const keptPicture = (editor: Locator) =>
  editor
    .getByTestId("mind-picture-image")
    .first()
    .evaluate((image) => {
      const element = image as HTMLImageElement;
      return {
        src: element.src,
        width: element.naturalWidth,
        height: element.naturalHeight,
        alt: element.alt,
      };
    });

test("a screenshot pasted becomes a picture; its description is written in place, and ⌘Z takes each back", async () => {
  const { app, window, editor } = await startNote("en", 900);
  try {
    const png = writePicture("Screenshot 2026-10-30 at 09.41.png", gradientPng());
    await loadFiles(window, [png]);
    await paste(window);
    await expect(editor.getByTestId("mind-picture")).toHaveCount(1);
    expect((await keptPicture(editor)).src).toMatch(/^data:image\//);

    // ⌘Z takes the pasted picture back, as any other change.
    await pointAndClick(window, editor);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor.getByTestId("mind-picture")).toHaveCount(0);

    // Pasted again, a click selects it and shows the line under it where the User describes it.
    await loadFiles(window, [png]);
    await paste(window);
    const picture = editor.getByTestId("mind-picture").first();
    await expect(picture).toBeVisible();
    await pointAndClick(window, picture);
    const alt = editor.getByTestId("picture-alt").first();
    await expect(alt).toBeVisible();
    await alt.fill("A chart of spring tides");
    await alt.press("Enter");
    expect((await keptPicture(editor)).alt).toBe("A chart of spring tides");

    // ⌘Z takes the description back; the picture stays.
    await pointAndClick(window, editor);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await keptPicture(editor)).alt).toBe("");
    await expect(editor.getByTestId("mind-picture")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("a dropped photo of many megabytes is made small enough to keep, and a JPEG dropped is a picture too", async () => {
  const { app, window, editor } = await startNote("zh-CN", 1600);
  try {
    const size = await window.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 6000;
      canvas.height = 4000;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No canvas.");
      const image = context.createImageData(6000, 4000);
      const pixels = image.data;
      let seed = 7;
      for (let at = 0; at < pixels.length; at += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        pixels[at] = seed & 0xff;
        pixels[at + 1] = (seed >>> 8) & 0xff;
        pixels[at + 2] = (seed >>> 16) & 0xff;
        pixels[at + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.92),
      );
      if (!blob) throw new Error("The photo wasn't made.");
      const target = document.querySelector('[data-testid="mind-editor"]');
      if (!target) throw new Error("No editor.");
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "IMG_2204.jpg", { type: "image/jpeg" }));
      const box = target.getBoundingClientRect();
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: box.x + 100,
          clientY: box.y + 40,
        }),
      );
      return blob.size;
    });
    expect(size).toBeGreaterThan(5 * 1024 * 1024);
    await expect(editor.getByTestId("mind-picture")).toHaveCount(1);
    const kept = await keptPicture(editor);
    expect(Math.max(kept.width, kept.height)).toBeLessThanOrEqual(1600);
    expect(kept.src.length).toBeLessThan(1_600_000);
    expect(kept.src).toMatch(/^data:image\/jpeg;/);
    // The description's line says what it is for, in Chinese.
    await pointAndClick(window, editor.getByTestId("mind-picture"));
    await expect(editor.getByTestId("picture-alt").first()).toHaveAttribute(
      "placeholder",
      "描述这张图片",
    );
  } finally {
    await app.close();
  }
});

test("a HEIC pasted is read by the computer's own decoder", async () => {
  test.skip(process.platform !== "darwin", "Only macOS's sips reads a HEIC here.");
  const png = writePicture("photo.png", gradientPng());
  const heic = join(dataDir, "photo.heic");
  execFileSync("sips", ["-s", "format", "heic", png, "--out", heic]);
  const { app, window, editor } = await startNote("en", 1280);
  try {
    await loadFiles(window, [heic]);
    await paste(window);
    await expect(editor.getByTestId("mind-picture")).toHaveCount(1);
    expect((await keptPicture(editor)).src).toMatch(/^data:image\/(png|jpeg);/);
  } finally {
    await app.close();
  }
});
