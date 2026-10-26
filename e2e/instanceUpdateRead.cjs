const fs = require("node:fs");
const { join, resolve } = require("node:path");
const folder = process.env.INCARNAMIND_DATA_DIR || process.argv[3];
if (!folder) throw new Error("The update-read fixture needs a temporary data folder.");
const file = resolve(join(folder, "instance-update.json"));
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
  if (typeof path === "string" && resolve(path) === file)
    throw Object.assign(new Error("The pending update fixture cannot read its metadata."), {
      code: "EACCES",
      path: file,
    });
  return read(path, ...args);
};
