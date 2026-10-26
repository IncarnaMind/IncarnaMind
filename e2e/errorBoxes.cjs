/**
 * Loaded before the app's main script (`electron -r <this file> <app>`): each error box the app
 * asks for is written to INCARNAMIND_TEST_ERROR_BOXES as a line of JSON, with whether the app was
 * ready by then, and none is shown. A smoke test can't read the system's dialog, and on Linux an
 * error box asked for before `ready` shows nothing (#1493). The app reads the system's language as
 * English, so the box's words are the same on a host that prefers Chinese.
 */
const { appendFileSync } = require("node:fs");
const { app, dialog } = require("electron");

app.getPreferredSystemLanguages = () => [process.env.INCARNAMIND_TEST_ERROR_LANGUAGE ?? "en-US"];

dialog.showErrorBox = (title, content) => {
  appendFileSync(
    process.env.INCARNAMIND_TEST_ERROR_BOXES,
    `${JSON.stringify({ title, content, ready: app.isReady() })}\n`,
  );
};
