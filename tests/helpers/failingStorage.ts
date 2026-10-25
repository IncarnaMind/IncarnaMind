import { join } from "node:path";
import { openDatabase } from "../../src/core/storage";

const FULL = "SELECT RAISE(ABORT, 'database or disk is full')";

/** The database of a data folder, by its file's name: the core's index would bring its workers into a smoke test. */
const databaseOf = (dataDir: string) => openDatabase(join(dataDir, "incarnamind.db"));

/**
 * Makes a data folder's database refuse writes as a full disk does (#1119), through
 * triggers on synthetic data, until the returned function is called: of Mind content only
 * (new rows, and with `updates` marking them deleted too), or, `every`, of every table.
 */
export function refuseWrites(
  dataDir: string,
  { every = false, updates = false }: { every?: boolean; updates?: boolean } = {},
) {
  const db = databaseOf(dataDir);
  const tables = every
    ? db
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
        )
        .map(({ name }) => name)
    : ["mind_updates"];
  const actions = every
    ? ["INSERT", "UPDATE", "DELETE"]
    : updates
      ? ["INSERT", "UPDATE"]
      : ["INSERT"];
  const triggers: string[] = [];
  for (const table of tables) {
    for (const action of actions) {
      const name = `refuse_${action}_${table}`;
      try {
        db.exec(`CREATE TRIGGER "${name}" BEFORE ${action} ON "${table}" BEGIN ${FULL}; END`);
        triggers.push(name);
      } catch {
        // A full-text index's own tables take no triggers; what writes them writes a table above.
      }
    }
  }
  return () => {
    for (const name of triggers) db.exec(`DROP TRIGGER "${name}"`);
    db.close();
  };
}

/**
 * Makes the commit of a transaction that deletes a Mind fail, as a full disk can at COMMIT,
 * until the returned function is called: the deletion leaves a row that breaks a deferred
 * foreign key, which SQLite checks only when it commits.
 */
export function failMindDeleteCommits(dataDir: string) {
  const db = databaseOf(dataDir);
  db.exec(
    "CREATE TABLE commit_probe (mind_id TEXT REFERENCES minds(id) DEFERRABLE INITIALLY DEFERRED)",
  );
  db.exec(
    "CREATE TRIGGER commit_probe_on_delete AFTER UPDATE OF deleted_at ON minds WHEN NEW.deleted_at IS NOT NULL BEGIN INSERT INTO commit_probe VALUES ('no such Mind'); END",
  );
  return () => {
    db.exec("DROP TRIGGER commit_probe_on_delete");
    db.exec("DROP TABLE commit_probe");
    db.close();
  };
}
