import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { removeStalePartials, writeNewFile } from "../../src/core/fileNames";
import { createTempDataFolder } from "../helpers/core";

/** What a hard link finds, as it is asked: what stood in the folder, and whether links work at all. */
const links = vi.hoisted(() => ({
  seen: [] as { finished: string | null; target: string; names: string[]; temporary: string }[],
  refuse: null as string | null,
  fail: false,
  full: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!links.full) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile") {
            return () =>
              Promise.reject(
                Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
              );
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    link: async (from: string, to: string) => {
      const folder = dirname(to);
      const names = await actual.readdir(folder);
      links.seen.push({
        finished: existsSync(to) ? "there" : null,
        target: to,
        names,
        temporary: await actual.readFile(from, "utf8"),
      });
      if (links.fail) throw new Error("The program stopped.");
      if (links.refuse !== null) {
        throw Object.assign(new Error("not supported"), { code: links.refuse });
      }
      return actual.link(from, to);
    },
  };
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe("Writing a new file (#1388)", () => {
  // protects=a name is claimed only once the whole file is written: when it is, nothing is under the name, and the temporary file holds every byte; fails_when=the name is made empty first, or the file is linked before it is written; no_claim=power loss.
  test("the name is taken only when the file is whole, so a stop before it leaves no empty file under the name", async () => {
    links.seen.length = 0;
    links.refuse = null;
    links.fail = false;
    const folder = await createTempDataFolder();

    const used = await writeNewFile(folder, "Tides.docx", bytes("all of the bytes"));

    expect(used).toBe("Tides.docx");
    const [first] = links.seen;
    expect(first?.finished).toBeNull();
    expect(first?.temporary).toBe("all of the bytes");
    expect(first?.names.filter((each) => each === "Tides.docx")).toEqual([]);
    expect(await readFile(join(folder, "Tides.docx"), "utf8")).toBe("all of the bytes");
    expect(await readdir(folder)).toEqual(["Tides.docx"]);
  });

  test("a failure while the name is being claimed leaves no file under it and no temporary one", async () => {
    links.seen.length = 0;
    links.fail = true;
    const folder = await createTempDataFolder();
    await expect(writeNewFile(folder, "Tides.docx", bytes("bytes"))).rejects.toThrow(
      "The program stopped.",
    );
    links.fail = false;
    expect(existsSync(join(folder, "Tides.docx"))).toBe(false);
    expect(await readdir(folder)).toEqual([]);
  });

  test("a full disk leaves neither the name nor a temporary file", async () => {
    links.refuse = null;
    links.fail = false;
    links.full = true;
    const folder = await createTempDataFolder();
    await expect(writeNewFile(folder, "Tides.docx", bytes("bytes"))).rejects.toThrow(
      "no space left on device",
    );
    links.full = false;
    expect(await readdir(folder)).toEqual([]);
  });

  test("a name that is taken, a file or a link, gets the next free one and is never replaced", async () => {
    links.refuse = null;
    links.fail = false;
    const folder = await createTempDataFolder();
    await writeFile(join(folder, "Tides.docx"), "mine");
    expect(await writeNewFile(folder, "Tides.docx", bytes("one"))).toBe("Tides 2.docx");
    expect(await writeNewFile(folder, "Tides.docx", bytes("two"))).toBe("Tides 3.docx");
    expect(await readFile(join(folder, "Tides.docx"), "utf8")).toBe("mine");
    expect((await readdir(folder)).sort()).toEqual(["Tides 2.docx", "Tides 3.docx", "Tides.docx"]);
  });

  test("two saves at once under one name each get a name of their own, whole", async () => {
    links.refuse = null;
    links.fail = false;
    const folder = await createTempDataFolder();
    const names = await Promise.all(
      ["one", "two", "three", "four"].map((text) => writeNewFile(folder, "Tides.md", bytes(text))),
    );
    expect(new Set(names).size).toBe(4);
    const contents = await Promise.all(names.map((name) => readFile(join(folder, name), "utf8")));
    expect(contents.sort()).toEqual(["four", "one", "three", "two"]);
    expect((await readdir(folder)).filter((each) => each.endsWith(".partial"))).toEqual([]);
  });

  test.each(["EPERM", "ENOTSUP", "EISDIR", "EINVAL", "UNKNOWN"])(
    "a file system with no hard links (%s) gets the name made first and the finished file renamed onto it",
    async (code) => {
      links.refuse = code;
      links.fail = false;
      const folder = await createTempDataFolder();
      await writeFile(join(folder, "Tides.docx"), "mine");
      expect(await writeNewFile(folder, "Tides.docx", bytes("whole"))).toBe("Tides 2.docx");
      expect(await readFile(join(folder, "Tides 2.docx"), "utf8")).toBe("whole");
      expect(await readFile(join(folder, "Tides.docx"), "utf8")).toBe("mine");
      expect((await readdir(folder)).sort()).toEqual(["Tides 2.docx", "Tides.docx"]);
      links.refuse = null;
    },
  );
});

describe("Temporary files an earlier run left (#1388)", () => {
  const old = new Date(Date.now() - 3_600_000);
  const ID = "0d9b5f4e-8a41-4c6e-9d3a-5b1f7a2c8e90";

  test("are taken out of a folder the first time it is written to, and nothing else is", async () => {
    links.refuse = null;
    links.fail = false;
    const folder = await createTempDataFolder();
    await mkdir(join(folder, "Subfolder"));
    const stale = [`.${ID}.partial`, `.Tides.docx.${ID}.partial`];
    for (const name of stale) {
      await writeFile(join(folder, name), "half");
      await utimes(join(folder, name), old, old);
    }
    for (const name of ["Tides.docx", ".hidden", ".download.partial", `notes.${ID}.partial`]) {
      await writeFile(join(folder, name), "keep");
      await utimes(join(folder, name), old, old);
    }

    await writeNewFile(folder, "Report.md", bytes("new"));

    expect((await readdir(folder)).sort()).toEqual(
      [
        ".download.partial",
        ".hidden",
        "Report.md",
        "Subfolder",
        "Tides.docx",
        `notes.${ID}.partial`,
      ].sort(),
    );
  });

  test("one newer than this run is another save's still being written, and stays", async () => {
    const folder = await createTempDataFolder();
    await writeFile(join(folder, `.${ID}.partial`), "being written");
    await removeStalePartials(folder);
    expect(await readdir(folder)).toEqual([`.${ID}.partial`]);
  });
});
