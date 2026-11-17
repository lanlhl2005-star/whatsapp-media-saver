import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 1;

/**
 * Build a stable message key string from Baileys WAMessageKey fields.
 */
export function buildMsgKey({ remoteJid, id, fromMe, participant } = {}) {
  const parts = [
    remoteJid || '',
    id || '',
    fromMe ? '1' : '0',
    participant || '',
  ];
  return parts.join('|');
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_messages (
      msg_key TEXT PRIMARY KEY,
      remote_jid TEXT,
      message_id TEXT,
      from_me INTEGER NOT NULL DEFAULT 0,
      participant TEXT,
      sender TEXT,
      ts INTEGER,
      media_type TEXT,
      folder_path TEXT,
      file_path TEXT,
      status TEXT NOT NULL,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_processed_status ON processed_messages(status);
    CREATE INDEX IF NOT EXISTS idx_processed_ts ON processed_messages(ts);

    CREATE TABLE IF NOT EXISTS sender_text_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      ts INTEGER NOT NULL,
      text TEXT NOT NULL,
      message_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_text_chat_sender_ts
      ON sender_text_cache(chat_id, sender, ts DESC);
  `);

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  }
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

export function getProcessed(db, msgKey) {
  return db.prepare('SELECT * FROM processed_messages WHERE msg_key = ?').get(msgKey);
}

export function upsertProcessed(db, row) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO processed_messages (
      msg_key, remote_jid, message_id, from_me, participant, sender, ts,
      media_type, folder_path, file_path, status, error, retry_count, created_at, updated_at
    ) VALUES (
      @msg_key, @remote_jid, @message_id, @from_me, @participant, @sender, @ts,
      @media_type, @folder_path, @file_path, @status, @error, @retry_count, @created_at, @updated_at
    )
    ON CONFLICT(msg_key) DO UPDATE SET
      remote_jid = excluded.remote_jid,
      message_id = excluded.message_id,
      from_me = excluded.from_me,
      participant = excluded.participant,
      sender = excluded.sender,
      ts = excluded.ts,
      media_type = excluded.media_type,
      folder_path = excluded.folder_path,
      file_path = excluded.file_path,
      status = excluded.status,
      error = excluded.error,
      retry_count = excluded.retry_count,
      updated_at = excluded.updated_at`,
  ).run({
    msg_key: row.msg_key,
    remote_jid: row.remote_jid ?? null,
    message_id: row.message_id ?? null,
    from_me: row.from_me ? 1 : 0,
    participant: row.participant ?? null,
    sender: row.sender ?? null,
    ts: row.ts ?? null,
    media_type: row.media_type ?? null,
    folder_path: row.folder_path ?? null,
    file_path: row.file_path ?? null,
    status: row.status,
    error: row.error ?? null,
    retry_count: row.retry_count ?? 0,
    created_at: row.created_at ?? now,
    updated_at: now,
  });
}

export function insertTextCache(db, { chatId, sender, ts, text, messageId }) {
  db.prepare(
    `INSERT INTO sender_text_cache (chat_id, sender, ts, text, message_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(chatId, sender, ts, text, messageId ?? null);
}

export function listRecentTexts(db, { chatId, sender, beforeTs, limit = 30 }) {
  return db
    .prepare(
      `SELECT chat_id AS chatId, sender, ts, text, message_id AS messageId
       FROM sender_text_cache
       WHERE chat_id = ? AND sender = ?
         AND ts >= ? AND ts <= ?
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(chatId, sender, beforeTs - 2 * 60 * 60, beforeTs + 2 * 60 * 60, limit);
}

/** Prune text cache older than retentionSeconds. */
export function pruneTextCache(db, retentionSeconds = 7 * 24 * 3600) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionSeconds;
  db.prepare('DELETE FROM sender_text_cache WHERE ts < ?').run(cutoff);
}

export function listFailedForRetry(db, limit = 50) {
  return db
    .prepare(
      `SELECT * FROM processed_messages
       WHERE status = 'failed' AND retry_count < 5
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .all(limit);
}
