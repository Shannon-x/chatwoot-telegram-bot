import Database from 'better-sqlite3';
import { config } from './config';

const db = new Database(config.dbPath);

export function initDb() {
  // 更适合高频写入的 SQLite 设置（默认 rollback journal + FULL 同步会更慢）
  // WAL: 读写并发更好、写入吞吐更高；NORMAL 同步在大多数场景更平衡性能与可靠性
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  // 允许在锁竞争时等待一段时间，避免偶发 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');
  // 负数表示 KB，给 SQLite page cache 一些空间（按需可调）
  db.pragma('cache_size = -64000'); // ~64MB

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      telegram_message_id INTEGER PRIMARY KEY,
      chatwoot_conversation_id INTEGER NOT NULL,
      chatwoot_account_id INTEGER,
      chatwoot_message_id INTEGER
    )
  `);
}

export function saveMapping(telegramMessageId: number, conversationId: number, accountId?: number, chatwootMessageId?: number) {
  insertMappingStmt.run(telegramMessageId, conversationId, accountId, chatwootMessageId);
}

export function getMapping(telegramMessageId: number) {
  return selectMappingStmt.get(telegramMessageId) as { chatwoot_conversation_id: number; chatwoot_account_id?: number; chatwoot_message_id?: number } | undefined;
}

// 预编译语句：避免每次调用都 prepare（高频写入场景更省 CPU）
const insertMappingStmt = db.prepare(
  'INSERT OR REPLACE INTO messages (telegram_message_id, chatwoot_conversation_id, chatwoot_account_id, chatwoot_message_id) VALUES (?, ?, ?, ?)'
);
const selectMappingStmt = db.prepare('SELECT * FROM messages WHERE telegram_message_id = ?');
