// Optional durable copy of the history in Turso (hosted SQLite), for hosts whose disk is wiped on
// restart (Render's free plan). The local SQLite file stays the working store, so reads, full-text
// search and the agent loop are unchanged. Every write is copied to Turso in order, and on startup the
// local store is refilled from Turso. Talks to Turso's SQL-over-HTTP API with fetch: no native driver.
import type { Store } from "./store.ts";

type Value = string | number | null;
type Wire = { type: "null" } | { type: "integer"; value: string } | { type: "float"; value: number } | { type: "text"; value: string };

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, visitor TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, local_date TEXT NOT NULL, timezone TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sources (message_id INTEGER NOT NULL, n INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, published TEXT, query TEXT NOT NULL, PRIMARY KEY (message_id, n))",
];

const encode = (v: Value): Wire =>
  v === null ? { type: "null" } : typeof v === "number" ? (Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v }) : { type: "text", value: v };
const decode = (w: Wire): Value => (w.type === "null" ? null : w.type === "integer" ? Number(w.value) : w.value);

export type Rows = Record<string, Value>[];

export function tursoMirror(url: string, token: string) {
  const endpoint = url.replace(/^libsql:\/\//, "https://").replace(/\/$/, "") + "/v2/pipeline";

  async function run(statements: { sql: string; args?: Value[] }[]): Promise<Rows[]> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requests: [...statements.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args ?? []).map(encode) } })), { type: "close" }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Turso returned HTTP ${res.status}`);
    const body = (await res.json()) as {
      results: ({ type: "ok"; response: { type: string; result?: { cols: { name: string }[]; rows: Wire[][] } } } | { type: "error"; error: { message: string } })[];
    };
    return body.results.slice(0, statements.length).map((r) => {
      if (r.type === "error") throw new Error(`Turso: ${r.error.message}`);
      const result = r.response.result!;
      return result.rows.map((row) => Object.fromEntries(row.map((cell, i) => [result.cols[i].name, decode(cell)])));
    });
  }

  // Writes made in the same tick (a whole turn's rows) go out together in one request, in order.
  // ponytail: a batch that fails while Turso is unreachable is logged, not retried; add a retry queue if that matters.
  let pending: { sql: string; args: Value[] }[] = [];
  let sending: Promise<void> | null = null;
  async function drain() {
    while (pending.length) {
      const batch = pending;
      pending = [];
      try {
        await run(batch);
      } catch (err) {
        console.error(`Turso copy failed for ${batch.length} writes: ${(err as Error).message}`);
      }
    }
    sending = null;
  }

  return {
    // Creates the tables if needed and copies everything into the (empty) local store.
    async restoreInto(store: Store): Promise<number> {
      await run(SCHEMA.map((sql) => ({ sql })));
      const [conversations, messages, sources] = await run([
        { sql: "SELECT id, title, created_at, visitor FROM conversations ORDER BY id" },
        { sql: "SELECT id, conversation_id, role, content, created_at, local_date, timezone FROM messages ORDER BY id" },
        { sql: "SELECT message_id, n, url, title, published, query FROM sources" },
      ]);
      store.restore({ conversations, messages, sources });
      return conversations.length;
    },
    push(sql: string, args: Value[]) {
      pending.push({ sql, args });
      sending ??= Promise.resolve().then(drain); // start after the current synchronous writes, so they batch
    },
    // Resolves once every write so far has been sent (used before the process exits).
    async flush() {
      while (sending) await sending;
    },
  };
}
