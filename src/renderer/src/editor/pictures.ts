import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { PICTURE_NODE } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { files } from "../core";
import { translateNow } from "../i18n";
import { useNotices } from "../notices";
import { isHeicPicture, preparePicture } from "../pictureFile";

const IMAGE_NAME = /\.(png|jpe?g|heic|heif|webp|gif|bmp|avif)$/i;

/** Whether copied HTML holds a picture that isn't the Note's own data URL, which a paste can't keep. */
function holdsForeignPicture(html: string): boolean {
  if (html === "") return false;
  const document = new DOMParser().parseFromString(html, "text/html");
  return [...document.querySelectorAll("img")].some(
    (image) => !(image.getAttribute("src") ?? "").startsWith("data:image/"),
  );
}

/**
 * A picture the web engine can't read (a HEIC), as a PNG: this computer's own decoder,
 * through the main process, which has none on Windows. Null where it can't be read.
 */
async function convertPicture(file: Blob): Promise<Blob | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = await files.decodePicture(bytes).catch(() => null);
  if (!png) return null;
  const buffer = new ArrayBuffer(png.byteLength);
  new Uint8Array(buffer).set(png);
  return new Blob([buffer], { type: "image/png" });
}

/** The picture files in what was pasted or dropped, in the order they come. */
export function pictureFilesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files).filter(
    (file) => file.type.startsWith("image/") || IMAGE_NAME.test(file.name),
  );
  if (files.length > 0) return files;
  return Array.from(data.items).flatMap((item) => {
    if (item.kind !== "file" || !item.type.startsWith("image/")) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

export type PictureProblem = "unreadable" | "empty" | "too-large" | "too-many-pixels" | "heic";

const PROBLEM_KEYS: Readonly<Record<PictureProblem, MessageKey>> = {
  unreadable: "editor.picture.unreadable",
  empty: "editor.picture.empty",
  "too-large": "editor.picture.tooLarge",
  "too-many-pixels": "editor.picture.tooManyPixels",
  heic: "editor.picture.heic",
};

export interface PictureInsertOptions {
  /** Where it goes, by position: the drop's place; absent, the selection's end. */
  at?: number;
  /** What to do with a picture that can't be kept (the editor says so in a Problem). */
  onProblem?: (problem: PictureProblem) => void;
}

/**
 * Puts pasted or dropped pictures in the Note as Blocks of their own (#1937),
 * after the paragraph the cursor or the drop is in, resized to fit. One that
 * can't be read says why, where it was let go, and nothing changes.
 */
export async function insertPictures(
  editor: Editor,
  files: readonly File[],
  { at, onProblem }: PictureInsertOptions = {},
): Promise<void> {
  // A Note a newer version wrote is only looked at: no picture goes into the copy either.
  if (!editor.isEditable) return;
  // Where it goes, read before a large picture takes a while to be prepared: the User may type
  // meanwhile, so every change until then moves the place it was asked for.
  const position = at === undefined ? editor.state.selection.to : at;
  const mapping = new Mapping();
  const follow = ({ transaction }: { transaction: { docChanged: boolean; mapping: Mapping } }) => {
    if (transaction.docChanged) mapping.appendMapping(transaction.mapping);
  };
  editor.on("transaction", follow);
  const kept: { type: string; attrs: Record<string, unknown> }[] = [];
  try {
    for (const file of files) {
      const prepared = await preparePicture(file, { convert: convertPicture });
      if ("problem" in prepared) {
        onProblem?.(
          prepared.problem === "unreadable" && isHeicPicture(file) ? "heic" : prepared.problem,
        );
        continue;
      }
      const { src, width, height } = prepared.picture;
      kept.push({ type: PICTURE_NODE, attrs: { src, width, height, alt: "" } });
    }
  } finally {
    editor.off("transaction", follow);
  }
  if (kept.length === 0 || editor.isDestroyed) return;
  const $at = editor.state.doc.resolve(
    Math.min(Math.max(mapping.map(position), 0), editor.state.doc.content.size),
  );
  // The block the pointer or the cursor is in ends before the picture goes in.
  const from = $at.depth > 0 ? $at.after(1) : $at.pos;
  const atEnd = from >= editor.state.doc.content.size;
  editor
    .chain()
    .insertContentAt(from, atEnd ? [...kept, { type: "paragraph" }] : kept)
    .run();
}

/** Asks the User for pictures on the computer and puts them in the Note, where "/" and ⌘K's Picture do. */
export function choosePictures(editor: Editor, options: PictureInsertOptions = {}): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,.heic,.heif";
  input.multiple = true;
  input.addEventListener(
    "change",
    () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      if (files.length > 0) void insertPictures(editor, files, options);
    },
    { once: true },
  );
  input.addEventListener("cancel", () => input.remove(), { once: true });
  document.body.append(input);
  input.click();
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pictures: {
      /** Asks the User for a picture and puts it in the Note ("/" › Picture, ⌘K). */
      choosePicture: () => ReturnType;
      /** Puts these pictures in the Note, as a paste or a drop does. */
      insertPictures: (files: File[]) => ReturnType;
    };
  }
}

/** Pastes and drops pictures into a Note; "/" and ⌘K's Picture put in one chosen from the computer. */
export const Pictures = Extension.create({
  name: "pictures",

  addCommands() {
    // A picture that can't be kept says why where the action was taken, never a silent nothing.
    const onProblem = (problem: PictureProblem) =>
      useNotices.getState().showError(new Error(translateNow(PROBLEM_KEYS[problem])));
    return {
      choosePicture:
        () =>
        ({ editor }) => {
          choosePictures(editor, { onProblem });
          return true;
        },
      insertPictures:
        (files) =>
        ({ editor }) => {
          void insertPictures(editor, files, { onProblem });
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const onProblem = (problem: PictureProblem) =>
      useNotices.getState().showError(new Error(translateNow(PROBLEM_KEYS[problem])));
    return [
      new Plugin({
        key: new PluginKey("pictures"),
        props: {
          handlePaste(_view, event) {
            const data = event.clipboardData;
            if (!data) return false;
            const html = data.getData("text/html");
            const words = html
              .replace(/<[^>]*>/g, " ")
              .replace(/&nbsp;|&#160;/gi, " ")
              .trim();
            // Words copied with a picture that isn't the Note's own (a page's paragraph and its
            // chart, Word's text and a picture): the words paste as they are and the picture
            // isn't added, said once. Copied alone (Chrome's Copy image), a picture pastes.
            if (words !== "" && (holdsForeignPicture(html) || pictureFilesOf(data).length > 0)) {
              useNotices.getState().confirm("editor.picture.pastedAsText");
              return false;
            }
            const files = pictureFilesOf(data);
            if (files.length === 0) return false;
            event.preventDefault();
            void insertPictures(editor, files, { onProblem });
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved) return false;
            const files = pictureFilesOf(event.dataTransfer);
            if (files.length === 0) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void insertPictures(editor, files, { at, onProblem });
            return true;
          },
        },
      }),
    ];
  },
});
