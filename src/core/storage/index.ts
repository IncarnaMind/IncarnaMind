/**
 * SWAP POINT for the SQLite driver.
 *
 * The retrieval prototype (ticket #21) decides the final driver: `node:sqlite`
 * or, if it falls short (e.g. loading sqlite-vec), better-sqlite3. To switch,
 * write another adapter that implements `Database` from `./database` and export
 * it here as `openDatabase`. Nothing else in the core imports a driver.
 */
export type { Database, SqlValue } from "./database";
export { migrate, migrations } from "./migrations";
export { heldByAnotherProcess, openNodeSqlite as openDatabase } from "./node-sqlite";
