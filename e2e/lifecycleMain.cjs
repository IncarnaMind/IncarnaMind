const { isAbsolute } = require("node:path");

// This entry is selected only by the packaged lifecycle test job; release builds keep index.js.
const preloads = JSON.parse(process.env.INCARNAMIND_TEST_MAIN_PRELOADS ?? "[]");
if (
  !Array.isArray(preloads) ||
  !preloads.every((file) => typeof file === "string" && isAbsolute(file))
)
  throw new Error("The packaged lifecycle preloads must be absolute file paths.");
globalThis.incarnamindLifecycleMain = { realMain: require.resolve("./index.js"), preloads };
for (const file of preloads) require(file);
require("./index.js");
