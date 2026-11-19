/**
 * The desktop app's `CanvasFiles` (#3406): a file an outside agent named, read where it is, and the
 * bytes of each Canvas version kept in the data folder's Canvases/, each under its SHA-256. Pure
 * Node, so it is tested without Electron.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CanvasFiles, NamedFile } from "../core/adapters";

const SHA256 = /^[0-9a-f]{64}$/;
const UNREADABLE: NamedFile = { kind: "unreadable" };
const TOO_LARGE: NamedFile = { kind: "too-large" };

/**
 * A FIFO would hold `open` until something writes to it; the descriptor is never read before
 * fstat shows a regular file. O_NOFOLLOW is the kernel's own refusal of a link swapped in after
 * lstat; where there is none (Windows), the file opened must be the one lstat saw.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** `folder`: Canvases/ in the data folder. */
export function createCanvasFiles(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): CanvasFiles {
  const pathOf = (hash: string) => {
    if (!SHA256.test(hash)) throw new Error("A Canvas's file is kept by its SHA-256.");
    return join(folder, hash.slice(0, 2), hash);
  };

  return {
    async readNamed(path, maxBytes) {
      // A UNC path would make Windows reach a server on the network, its own device paths among them.
      if (!isAbsolute(path) || (platform === "win32" && /^[\\/]{2}/.test(path))) return UNREADABLE;
      let handle: FileHandle | undefined;
      try {
        const named = await lstat(path);
        if (!named.isFile()) return UNREADABLE;
        if (named.size > maxBytes) return TOO_LARGE;
        handle = await open(path, OPEN_FLAGS);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
          return UNREADABLE;
        }
        if (opened.size > maxBytes) return TOO_LARGE;
        // One byte more than it says it holds: a file still being written is not taken half.
        const bytes = new Uint8Array(opened.size + 1);
        let read = 0;
        while (read < bytes.length) {
          const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return read === opened.size ? { kind: "read", bytes: bytes.subarray(0, read) } : UNREADABLE;
      } catch {
        return UNREADABLE;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },

    async write(hash, bytes) {
      const file = pathOf(hash);
      const kept = await access(file).then(
        () => true,
        () => false,
      );
      if (kept) return;
      await mkdir(dirname(file), { recursive: true });
      const partial = `${file}.${randomUUID()}.part`;
      try {
        await writeFile(partial, bytes, { mode: 0o600 });
        await rename(partial, file);
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
    },

    async read(hash) {
      try {
        return new Uint8Array(await readFile(pathOf(hash)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
