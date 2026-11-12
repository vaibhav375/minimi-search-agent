// Persistent memory: raw, timestamped transcripts in SQLite (built into Node, no native build step).
// Every message carries its UTC time and the user's local calendar date, so "what did I ask on
// 3 November" is a plain WHERE clause rather than a semantic guess.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "user" | "assistant";

export interface Source {
  n: number;
  url: string;
  title: string;
  published: string | null;
  query: string;
}

export interface StoredMessage {
  id: number;
  conversationId: number;
  role: Role;
  content: string;
  createdAt: string;
  localDate: string;
  timezone: string;
  sources: Source[];
}

export interface ConversationSummary {
  id: number;
  title: string;
  createdAt: string;
  lastAt: string;
}

export interface ConversationHit {
  id: number;
  title: string;
  dates: string[]; // local dates of the messages that matched
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  visitor     TEXT NOT NULL DEFAULT 'local'
);
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  local_date      TEXT NOT NULL,
  timezone        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_date ON messages(local_date);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS sources (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  n          INTEGER NOT NULL,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  published  TEXT,
  query      TEXT NOT NULL,
  PRIMARY KEY (message_id, n)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

// Calendar date (YYYY-MM-DD) of an instant in an IANA time zone.
export function localDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export class Store {
  private db: DatabaseSync;
  private visitor: string; // whose conversations this view reads and writes

  constructor(path = "data/chat.db", visitor = "local") {
    this.visitor = visitor;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // Databases created before visitors existed get the column added in place.
    const columns = this.db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "visitor")) this.db.exec("ALTER TABLE conversations ADD COLUMN visitor TEXT NOT NULL DEFAULT 'local'");
    this.db.exec("CREATE INDEX IF NOT EXISTS conversations_by_visitor ON conversations(visitor)");
  }

  // The same database, limited to one visitor's conversations. On a public deployment each browser
  // gets its own id, so nobody can list, open or recall anyone else's history.
  scoped(visitor: string): Store {
    return Object.assign(Object.create(Store.prototype) as Store, { db: this.db, visitor });
  }

  createConversation(title: string, at: Date): number {
    const r = this.db.prepare("INSERT INTO conversations (title, created_at, visitor) VALUES (?, ?, ?)").run(title, at.toISOString(), this.visitor);
    return Number(r.lastInsertRowid);
  }

  conversationExists(id: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM conversations WHERE id = ? AND visitor = ?").get(id, this.visitor);
  }

  addMessage(m: { conversationId: number; role: Role; content: string; at: Date; timezone: string }): number {
    const r = this.db
      .prepare("INSERT INTO messages (conversation_id, role, content, created_at, local_date, timezone) VALUES (?, ?, ?, ?, ?, ?)")
      .run(m.conversationId, m.role, m.content, m.at.toISOString(), localDate(m.at, m.timezone), m.timezone);
    return Number(r.lastInsertRowid);
  }

  addSources(messageId: number, sources: Source[]): void {
    const insert = this.db.prepare("INSERT INTO sources (message_id, n, url, title, published, query) VALUES (?, ?, ?, ?, ?, ?)");
    for (const s of sources) insert.run(messageId, s.n, s.url, s.title, s.published, s.query);
  }

  // Conversations that have at least one saved exchange, most recently active first.
  listConversations(): ConversationSummary[] {
    return this.db
      .prepare(
        `SELECT c.id, c.title, c.created_at AS createdAt, COALESCE(MAX(m.created_at), c.created_at) AS lastAt
         FROM conversations c JOIN messages m ON m.conversation_id = c.id
         WHERE c.visitor = ?
         GROUP BY c.id ORDER BY lastAt DESC`,
      )
      .all(this.visitor) as unknown as ConversationSummary[];
  }

  conversationTitle(id: number): string {
    return (this.db.prepare("SELECT title FROM conversations WHERE id = ?").get(id) as { title: string } | undefined)?.title ?? "";
  }

  // Full transcript with each assistant message's sources. `limit` keeps only the most recent messages.
  messages(conversationId: number, limit = 1000): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT id, conversation_id AS conversationId, role, content, created_at AS createdAt,
                  local_date AS localDate, timezone
           FROM messages
           WHERE conversation_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE visitor = ?)
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id`,
      )
      .all(conversationId, this.visitor, limit) as unknown as Omit<StoredMessage, "sources">[];
    const sourcesOf = this.db.prepare("SELECT n, url, title, published, query FROM sources WHERE message_id = ? ORDER BY n");
    return rows.map((r) => ({ ...r, sources: sourcesOf.all(r.id) as unknown as Source[] }));
  }

  // Conversations with at least one message on any of the given local dates.
  conversationsOnDates(dates: string[], excludeId?: number): ConversationHit[] {
    if (!dates.length) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, GROUP_CONCAT(DISTINCT m.local_date) AS dates
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.local_date IN (${dates.map(() => "?").join(",")}) AND c.id != ? AND c.visitor = ?
         GROUP BY c.id ORDER BY MIN(m.id)`,
      )
      .all(...dates, excludeId ?? -1, this.visitor) as { id: number; title: string; dates: string }[];
    return rows.map((r) => ({ id: r.id, title: r.title, dates: r.dates.split(",").sort() }));
  }

  // Keyword search (FTS5, BM25-ranked) over all messages, grouped by conversation, best first.
  searchConversations(terms: string[], excludeId?: number, limit = 3): ConversationHit[] {
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `WITH hit AS MATERIALIZED (SELECT rowid, bm25(messages_fts) AS score FROM messages_fts WHERE messages_fts MATCH ?)
         SELECT c.id, c.title, GROUP_CONCAT(DISTINCT m.local_date) AS dates, MIN(hit.score) AS score
         FROM hit JOIN messages m ON m.id = hit.rowid JOIN conversations c ON c.id = m.conversation_id
         WHERE c.id != ? AND c.visitor = ?
         GROUP BY c.id ORDER BY score LIMIT ?`,
      )
      .all(match, excludeId ?? -1, this.visitor, limit) as { id: number; title: string; dates: string }[];
    return rows.map((r) => ({ id: r.id, title: r.title, dates: r.dates.split(",").sort() }));
  }

  // How well each conversation matches the terms (higher is better); used to rank same-day conversations.
  keywordScores(conversationIds: number[], terms: string[]): Map<number, number> {
    const scores = new Map<number, number>();
    if (!conversationIds.length || !terms.length) return scores;
    const match = terms.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `WITH hit AS MATERIALIZED (SELECT rowid, bm25(messages_fts) AS score FROM messages_fts WHERE messages_fts MATCH ?)
         SELECT m.conversation_id AS id, -MIN(hit.score) AS score
         FROM hit JOIN messages m ON m.id = hit.rowid
         WHERE m.conversation_id IN (${conversationIds.map(() => "?").join(",")})
         GROUP BY m.conversation_id`,
      )
      .all(match, ...conversationIds) as { id: number; score: number }[];
    for (const r of rows) scores.set(r.id, r.score);
    return scores;
  }

  // The local dates that have conversations, nearest to `date` first (for an honest "nothing on that day").
  nearestDates(date: string, excludeId?: number, limit = 3): { date: string; titles: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT m.local_date AS date, json_group_array(DISTINCT c.title) AS titles
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.id != ? AND c.visitor = ?
         GROUP BY m.local_date
         ORDER BY ABS(julianday(m.local_date) - julianday(?)) LIMIT ?`,
      )
      .all(excludeId ?? -1, this.visitor, date, limit) as { date: string; titles: string }[];
    return rows.map((r) => ({ date: r.date, titles: JSON.parse(r.titles) as string[] }));
  }
}
