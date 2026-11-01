/**
 * 存储层：连接、PRAGMA、迁移。
 *
 * 设计立场：
 *   · events 是**不可变的真相**，任何修订都用新 event 表达并指回旧 event；
 *   · FTS5 用外部内容表（content='events'），靠触发器同步，避免两份数据漂移；
 *   · 迁移用 PRAGMA user_version 顺序推进，每一步都在事务里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveInstance } from './instance.mjs';

const SCHEMA_V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  uid        TEXT    NOT NULL UNIQUE,
  ts         INTEGER NOT NULL,
  tz         TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  body       TEXT    NOT NULL DEFAULT '',
  actors     TEXT    NOT NULL DEFAULT '[]',
  refs       TEXT    NOT NULL DEFAULT '[]',
  session_id TEXT,
  hash       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_events_hash ON events(hash);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_source ON events(source, ts);

-- 中文用 trigram：不依赖分词，>=3 字的查询直接命中；
-- <3 字的查询由 search.mjs 退化为 LIKE（见该文件注释）。
CREATE VIRTUAL TABLE events_fts USING fts5(
  title,
  body,
  content = 'events',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO events_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE entities (
  id         INTEGER PRIMARY KEY,
  uid        TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'thing',
  aliases    TEXT    NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_entities_name_kind ON entities(name, kind);

CREATE TABLE event_entities (
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role      TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (event_id, entity_id, role)
) STRICT;

CREATE INDEX idx_event_entities_entity ON event_entities(entity_id, event_id);

CREATE TABLE summaries (
  id             INTEGER PRIMARY KEY,
  uid            TEXT    NOT NULL UNIQUE,
  level          TEXT    NOT NULL,
  bucket_start   INTEGER NOT NULL,
  bucket_end     INTEGER NOT NULL,
  tz             TEXT    NOT NULL,
  text           TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'ready',
  prompt_version TEXT    NOT NULL,
  model          TEXT,
  source_count   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(level, bucket_start, prompt_version)
) STRICT;

CREATE INDEX idx_summaries_level ON summaries(level, bucket_start);
`;

const SCHEMA_V2 = `
-- 主动消息的流水：既用来算"今天说了几次"，也是"我说过什么"的证据。
CREATE TABLE proactive_log (
  id    INTEGER PRIMARY KEY,
  ts    INTEGER NOT NULL,
  kind  TEXT    NOT NULL DEFAULT 'ping',
  text  TEXT    NOT NULL DEFAULT '',
  meta  TEXT    NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX idx_proactive_ts ON proactive_log(ts);
`;

const SCHEMA_V3 = `
-- 摘要覆盖到哪条事件：新事件落进已经摘过的桶时，要能重新摘
ALTER TABLE summaries ADD COLUMN covered_until INTEGER NOT NULL DEFAULT 0;
`;

const SCHEMA_V4 = `
-- 摘要按来源切分：'all' 是合并版，qq/web 各自一份。
-- UNIQUE 约束没法 ALTER，所以重建表再搬数据。
CREATE TABLE summaries_v4 (
  id             INTEGER PRIMARY KEY,
  uid            TEXT    NOT NULL UNIQUE,
  level          TEXT    NOT NULL,
  bucket_start   INTEGER NOT NULL,
  bucket_end     INTEGER NOT NULL,
  tz             TEXT    NOT NULL,
  text           TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'ready',
  prompt_version TEXT    NOT NULL,
  model          TEXT,
  source_count   INTEGER NOT NULL DEFAULT 0,
  covered_until  INTEGER NOT NULL DEFAULT 0,
  source         TEXT    NOT NULL DEFAULT 'all',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(level, bucket_start, prompt_version, source)
) STRICT;

INSERT INTO summaries_v4
  (id, uid, level, bucket_start, bucket_end, tz, text, status, prompt_version,
   model, source_count, covered_until, source, created_at, updated_at)
SELECT id, uid, level, bucket_start, bucket_end, tz, text, status, prompt_version,
       model, source_count, covered_until, 'all', created_at, updated_at
  FROM summaries;

DROP TABLE summaries;
ALTER TABLE summaries_v4 RENAME TO summaries;
CREATE INDEX idx_summaries_level ON summaries(level, bucket_start);
`;

const SCHEMA_V5 = `
-- 增量采集的游标：记录每个会话文件读到哪、以及从第一帧解出来的头信息
CREATE TABLE harvest_state (
  path       TEXT PRIMARY KEY,
  offset     INTEGER NOT NULL DEFAULT 0,
  size       INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  source     TEXT,
  created_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
`;

const MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
  { version: 5, sql: SCHEMA_V5 },
];

/** @returns {number} 迁移后的 schema 版本 */
export function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  let version = Number(row?.user_version ?? 0);
  for (const step of MIGRATIONS) {
    if (step.version <= version) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(step.sql);
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    version = step.version;
  }
  return version;
}

/**
 * 打开（必要时创建）数据库。
 * @param {string} [file] 默认取 WHALEFALL_DB，否则当前个体的 memory.db；':memory:' 用于测试
 */
export function openDb(file = process.env.WHALEFALL_DB || resolveInstance().db) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      /* 某些文件系统不支持 WAL，退回默认模式即可 */
    }
  }
  migrate(db);
  return db;
}

export function closeDb(db) {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
}
