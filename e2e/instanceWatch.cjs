const fs = require("node:fs");
const { basename } = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const watch = fs.watch;
fs.watch = function (file, ...args) {
  if (basename(String(file)) === "instance-requests") {
    const listener = args.findIndex((arg) => typeof arg === "function");
    if (listener >= 0) args[listener] = () => {};
  }
  return watch.call(this, file, ...args);
};
syncBuiltinESMExports();
