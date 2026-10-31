/**
 * Opens the content database on its own connection and applies its pending migrations, off the
 * main thread, while the first window loads (#2104). The connection is closed before the thread
 * ends, so the core opens a migrated file that nothing else holds.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { LogFields } from "../core/adapters";
import { migrate, openDatabase } from "../core/storage";

export type MigrationMessage =
  | { kind: "applied"; version: number }
  | { kind: "log"; level: "info" | "warn" | "error"; event: string; fields?: LogFields };

const port = parentPort;
if (!port) throw new Error("The migration worker must run as a worker thread.");
const { file } = workerData as { file: string };
const send = (message: MigrationMessage) => port.postMessage(message);

mkdirSync(dirname(file), { recursive: true });
const db = openDatabase(file, {
  info: (event, fields) => send({ kind: "log", level: "info", event, ...(fields && { fields }) }),
  warn: (event, fields) => send({ kind: "log", level: "warn", event, ...(fields && { fields }) }),
  error: (event, fields) => send({ kind: "log", level: "error", event, ...(fields && { fields }) }),
});
try {
  migrate(db, undefined, (version) => send({ kind: "applied", version }));
} finally {
  db.close();
}
