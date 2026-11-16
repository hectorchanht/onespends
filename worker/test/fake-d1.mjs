// Minimal D1-shaped adapter over node:sqlite for local worker tests.
// Implements exactly the surface @dawn-studio/auth's createD1Store + the
// OneSpends worker use: prepare(sql).bind(...).first() / .run() / .all().
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function makeFakeD1() {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const lines = schema.split("\n").filter((ln) => !ln.trim().startsWith("--"));
  for (const stmt of lines.join("\n").split(";")) {
    const s = stmt.trim();
    if (s) db.exec(s);
  }
  class Stmt {
    constructor(sql) {
      this.sql = sql;
      this.params = [];
    }
    bind(...args) {
      this.params = args;
      return this;
    }
    async first(col) {
      const rows = db.prepare(this.sql).all(...this.params);
      const row = rows.length ? rows[0] : null;
      if (row == null) return null;
      return col ? row[col] : row;
    }
    async run() {
      const info = db.prepare(this.sql).run(...this.params);
      return { success: true, meta: { changes: Number(info.changes) } };
    }
    async all() {
      const rows = db.prepare(this.sql).all(...this.params);
      return { results: rows, success: true, meta: {} };
    }
  }
  return {
    prepare: (sql) => new Stmt(sql),
    _raw: db, // test-only escape hatch (e.g. force-expire a trial)
  };
}
