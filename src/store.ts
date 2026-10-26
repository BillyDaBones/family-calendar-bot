import { Database } from "bun:sqlite";

export interface StoredEvent {
  id: number;
  gcalId: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  notes: string;
  createdBy: string;
  status: "active" | "cancelled";
}

export interface PendingQuestion {
  botTs: number;
  question: string;
  originalText: string;
  originalAuthor: string;
  originalTs: number;
  createdAt: number;
}

type EventRow = {
  id: number;
  gcal_id: string;
  title: string;
  start: string;
  end: string | null;
  all_day: number;
  location: string | null;
  notes: string;
  created_by: string;
  status: "active" | "cancelled";
};

function toEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    gcalId: row.gcal_id,
    title: row.title,
    start: row.start,
    end: row.end,
    allDay: row.all_day === 1,
    location: row.location,
    notes: row.notes,
    createdBy: row.created_by,
    status: row.status,
  };
}

// Only events, message→event links and open questions are stored. Message text
// from the group is never persisted, except the original text of a message the
// bot asked a question about (needed to finish creating that event).
export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gcal_id TEXT NOT NULL,
      title TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT,
      all_day INTEGER NOT NULL,
      location TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    )`);
    // A Signal message is identified by (timestamp, author number).
    this.db.run(`CREATE TABLE IF NOT EXISTS links (
      signal_ts INTEGER NOT NULL,
      author TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (signal_ts, author)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS pending (
      bot_ts INTEGER PRIMARY KEY,
      question TEXT NOT NULL,
      original_text TEXT NOT NULL,
      original_author TEXT NOT NULL,
      original_ts INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  insertEvent(e: Omit<StoredEvent, "id" | "status">): StoredEvent {
    const row = this.db
      .query<EventRow, any[]>(
        `INSERT INTO events (gcal_id, title, start, end, all_day, location, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(e.gcalId, e.title, e.start, e.end, e.allDay ? 1 : 0, e.location, e.notes, e.createdBy)!;
    return toEvent(row);
  }

  updateEvent(e: StoredEvent): void {
    this.db
      .query(
        `UPDATE events SET title = ?, start = ?, end = ?, all_day = ?, location = ?, notes = ?, status = ?
         WHERE id = ?`,
      )
      .run(e.title, e.start, e.end, e.allDay ? 1 : 0, e.location, e.notes, e.status, e.id);
  }

  getEvent(id: number): StoredEvent | null {
    const row = this.db.query<EventRow, [number]>("SELECT * FROM events WHERE id = ?").get(id);
    return row ? toEvent(row) : null;
  }

  // Active events starting on or after `fromDate` and before `toDate` (exclusive), soonest first.
  eventsBetween(fromDate: string, toDate: string): StoredEvent[] {
    return this.db
      .query<EventRow, [string, string]>(
        `SELECT * FROM events WHERE status = 'active' AND substr(start, 1, 10) >= ? AND substr(start, 1, 10) < ?
         ORDER BY start`,
      )
      .all(fromDate, toDate)
      .map(toEvent);
  }

  link(signalTs: number, author: string, eventId: number, kind: "source" | "bot" | "update" | "detail"): void {
    this.db
      .query("INSERT OR REPLACE INTO links (signal_ts, author, event_id, kind) VALUES (?, ?, ?, ?)")
      .run(signalTs, author, eventId, kind);
  }

  linkedEvent(signalTs: number, author: string): StoredEvent | null {
    const row = this.db
      .query<{ event_id: number }, [number, string]>("SELECT event_id FROM links WHERE signal_ts = ? AND author = ?")
      .get(signalTs, author);
    return row ? this.getEvent(row.event_id) : null;
  }

  addPending(p: PendingQuestion): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO pending (bot_ts, question, original_text, original_author, original_ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(p.botTs, p.question, p.originalText, p.originalAuthor, p.originalTs, p.createdAt);
  }

  // Open questions newer than `since` (ms epoch). Older ones are deleted.
  openPending(since: number): PendingQuestion[] {
    this.db.query("DELETE FROM pending WHERE created_at < ?").run(since);
    return this.db
      .query<
        {
          bot_ts: number;
          question: string;
          original_text: string;
          original_author: string;
          original_ts: number;
          created_at: number;
        },
        []
      >("SELECT * FROM pending ORDER BY created_at")
      .all()
      .map((r) => ({
        botTs: r.bot_ts,
        question: r.question,
        originalText: r.original_text,
        originalAuthor: r.original_author,
        originalTs: r.original_ts,
        createdAt: r.created_at,
      }));
  }

  removePending(botTs: number): void {
    this.db.query("DELETE FROM pending WHERE bot_ts = ?").run(botTs);
  }
}
