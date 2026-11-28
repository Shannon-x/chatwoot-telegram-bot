import Database from 'better-sqlite3';
import { config } from './config';
import { createLogger } from './logger';
import { acquireOwnership } from './ownership-lock';

const log = createLogger('database');
const db = new Database(config.dbPath);
let releaseOwnership: (() => void) | undefined;

const CURRENT_DB_VERSION = 8;

let insertMappingStmt: Database.Statement;
let selectMappingStmt: Database.Statement;
let insertTopicStmt: Database.Statement;
let selectTopicStmt: Database.Statement;
let deleteTopicStmt: Database.Statement;
let selectTopicByTopicIdStmt: Database.Statement;

function getDatabaseVersion(): number {
    try {
        const result = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
        return result?.version || 0;
    } catch {
        return 0;
    }
}

function setDatabaseVersion(version: number): void {
    db.prepare('INSERT OR REPLACE INTO schema_version (id, version, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)').run(version);
}

function createSchemaVersionTable(): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function migrateToVersion1(): void {
    log.info('Migrating to v1: creating messages table');
    db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      telegram_message_id INTEGER PRIMARY KEY,
      chatwoot_conversation_id INTEGER NOT NULL,
      chatwoot_account_id INTEGER,
      chatwoot_message_id INTEGER
    )
  `);
}

function migrateToVersion2(): void {
    log.info('Migrating to v2: creating topics table');
    db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      chatwoot_conversation_id INTEGER PRIMARY KEY,
      chatwoot_account_id INTEGER,
      telegram_topic_id INTEGER NOT NULL,
      topic_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function migrateToVersion3(): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      conversation_id INTEGER NOT NULL,
      payload TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'delivered')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS webhook_queue_pending ON webhook_queue(state, next_attempt_at, id);
  `);
}

function migrateToVersion4(): void {
    db.exec(`ALTER TABLE webhook_queue ADD COLUMN text_sent INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE webhook_queue ADD COLUMN attachment_index INTEGER NOT NULL DEFAULT 0;`);
}

function migrateToVersion5(): void {
    db.exec(`ALTER TABLE webhook_queue ADD COLUMN text_chunk_index INTEGER NOT NULL DEFAULT 0;`);
}

function migrateToVersion6(): void {
    db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      baseline INTEGER NOT NULL,
      checkpoint INTEGER NOT NULL
    )`);
}

function migrateToVersion7(): void {
    // Existing v6 rows lack an authenticated source identity and cannot safely
    // be adopted without an operator choosing a fresh activation boundary.
    db.exec(`ALTER TABLE reconciliation_state ADD COLUMN account_id INTEGER;
             ALTER TABLE reconciliation_state ADD COLUMN inbox_id INTEGER;`);
}

function migrateToVersion8(): void {
    db.exec(`ALTER TABLE webhook_queue ADD COLUMN inflight TEXT;
    CREATE TABLE bridge_outgoing_sources (
      source_id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, conversation_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL, telegram_chat_id TEXT NOT NULL, telegram_message_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
      created_at INTEGER NOT NULL, UNIQUE(telegram_chat_id, telegram_message_id)
    );`);
}

export function reconciliationState(nowSeconds: number, accountId: number, inboxId: number): { baseline: number; checkpoint: number } {
    if (!Number.isSafeInteger(accountId) || accountId <= 0 || !Number.isSafeInteger(inboxId) || inboxId <= 0) {
        throw new Error('Invalid reconciliation source');
    }
    const existing = db.prepare('SELECT baseline, checkpoint, account_id, inbox_id FROM reconciliation_state WHERE id = 1').get() as
        { baseline: number; checkpoint: number; account_id: number | null; inbox_id: number | null } | undefined;
    if (existing) {
        if (existing.account_id !== accountId || existing.inbox_id !== inboxId) {
            throw new Error('Reconciliation checkpoint does not match configured account and inbox');
        }
        return {baseline: existing.baseline, checkpoint: existing.checkpoint};
    }
    // The operator captures this before stopping the old bridge. Older versions
    // may lack queue keys, so it must not be guessed from all prior history.
    const raw = process.env.RECONCILIATION_BASELINE_UNIX;
    if (!raw || !/^[0-9]+$/.test(raw)) throw new Error('RECONCILIATION_BASELINE_UNIX is required on first activation');
    const baseline = Number(raw);
    if (!Number.isSafeInteger(baseline) || baseline <= 0 || baseline > nowSeconds) {
        throw new Error('Invalid RECONCILIATION_BASELINE_UNIX');
    }
    db.prepare('INSERT INTO reconciliation_state (id, baseline, checkpoint, account_id, inbox_id) VALUES (1, ?, ?, ?, ?)')
        .run(baseline, baseline, accountId, inboxId);
    return { baseline, checkpoint: baseline };
}

export function advanceReconciliation(checkpoint: number): void {
    db.prepare('UPDATE reconciliation_state SET checkpoint = MAX(checkpoint, ?) WHERE id = 1').run(checkpoint);
}

function runMigrations(currentVersion: number): void {
    log.info(`Database version: ${currentVersion}, target: ${CURRENT_DB_VERSION}`);

    if (currentVersion > CURRENT_DB_VERSION) throw new Error('Database version is newer than this application');

    if (currentVersion === CURRENT_DB_VERSION) {
        log.info('Database is up to date');
        return;
    }

    const migrate = db.transaction(() => {
        if (currentVersion < 1) {
            migrateToVersion1();
            setDatabaseVersion(1);
        }
        if (currentVersion < 2) {
            migrateToVersion2();
            setDatabaseVersion(2);
        }
        if (currentVersion < 3) {
            migrateToVersion3();
            setDatabaseVersion(3);
        }
        if (currentVersion < 4) {
            migrateToVersion4();
            setDatabaseVersion(4);
        }
        if (currentVersion < 5) {
            migrateToVersion5();
            setDatabaseVersion(5);
        }
        if (currentVersion < 6) {
            migrateToVersion6();
            setDatabaseVersion(6);
        }
        if (currentVersion < 7) {
            migrateToVersion7();
            setDatabaseVersion(7);
        }
        if (currentVersion < 8) {
            migrateToVersion8();
            setDatabaseVersion(8);
        }
    });

    try {
        migrate();
        log.info(`Database migration complete, now at v${CURRENT_DB_VERSION}`);
    } catch (error) {
        log.error('Database migration failed', { error: String(error) });
        throw error;
    }
}

function initPreparedStatements(): void {
    insertMappingStmt = db.prepare(
        'INSERT OR REPLACE INTO messages (telegram_message_id, chatwoot_conversation_id, chatwoot_account_id, chatwoot_message_id) VALUES (?, ?, ?, ?)'
    );
    selectMappingStmt = db.prepare('SELECT * FROM messages WHERE telegram_message_id = ?');

    insertTopicStmt = db.prepare(
        'INSERT OR REPLACE INTO topics (chatwoot_conversation_id, chatwoot_account_id, telegram_topic_id, topic_name) VALUES (?, ?, ?, ?)'
    );
    selectTopicStmt = db.prepare('SELECT telegram_topic_id, topic_name, chatwoot_account_id FROM topics WHERE chatwoot_conversation_id = ?');
    deleteTopicStmt = db.prepare('DELETE FROM topics WHERE chatwoot_conversation_id = ?');
    selectTopicByTopicIdStmt = db.prepare('SELECT chatwoot_conversation_id, chatwoot_account_id, topic_name FROM topics WHERE telegram_topic_id = ?');
}

export function initDb() {
    log.info('Initializing database...');

    // Opening the target above creates a first-run DB before canonicalization.
    // No migration or worker access is allowed without exclusive ownership.
    releaseOwnership = acquireOwnership(config.dbPath);

    db.pragma('journal_mode = WAL');
    // A successful webhook response must not precede a durable SQLite commit.
    db.pragma('synchronous = FULL');
    db.pragma('temp_store = MEMORY');
    db.pragma('busy_timeout = 5000');
    db.pragma('cache_size = -64000');

    createSchemaVersionTable();
    const currentVersion = getDatabaseVersion();
    runMigrations(currentVersion);
    const columns = db.prepare('PRAGMA table_info(reconciliation_state)').all() as Array<{name: string}>;
    if (!columns.some(c => c.name === 'account_id') || !columns.some(c => c.name === 'inbox_id')) {
        throw new Error('Database schema does not match this application');
    }
    initPreparedStatements();

    log.info('Database initialization complete');
}

// ============ Messages ============

export function saveMapping(telegramMessageId: number, conversationId: number, accountId?: number, chatwootMessageId?: number) {
    insertMappingStmt.run(telegramMessageId, conversationId, accountId, chatwootMessageId);
}

export function getMapping(telegramMessageId: number) {
    return selectMappingStmt.get(telegramMessageId) as { chatwoot_conversation_id: number; chatwoot_account_id?: number; chatwoot_message_id?: number } | undefined;
}

// ============ Topics ============

export function saveTopic(conversationId: number, accountId: number | undefined, topicId: number, topicName: string) {
    insertTopicStmt.run(conversationId, accountId, topicId, topicName);
}

export function getTopic(conversationId: number) {
    return selectTopicStmt.get(conversationId) as { telegram_topic_id: number; topic_name: string; chatwoot_account_id?: number } | undefined;
}

export function deleteTopic(conversationId: number) {
    deleteTopicStmt.run(conversationId);
}

export function getTopicByTopicId(telegramTopicId: number) {
    return selectTopicByTopicIdStmt.get(telegramTopicId) as { chatwoot_conversation_id: number; chatwoot_account_id?: number; topic_name: string } | undefined;
}

// ============ Durable webhook inbox ============
// A single bridge instance owns this database. Rows stay pending until work
// completes; on a crash they are retried, possibly duplicating remote effects.
export interface QueuedWebhook {
    id: number;
    conversation_id: number;
    payload: string;
    attempts: number;
    text_sent: number;
    text_chunk_index: number;
    attachment_index: number;
}

export function enqueueWebhook(eventKey: string, conversationId: number, payload: string): boolean {
    // Preserve already forwarded messages on upgrade from pre-queue databases.
    // This is best effort: legacy mappings cannot prove that every attachment
    // was sent successfully.
    const message = /^message:([1-9]\d*):([1-9]\d*)$/.exec(eventKey);
    if (message && db.prepare(`SELECT 1 FROM messages WHERE chatwoot_account_id = ?
        AND chatwoot_conversation_id = ? AND chatwoot_message_id = ? LIMIT 1`)
        .get(Number(message[1]), conversationId, Number(message[2]))) return false;
    const result = db.prepare(`INSERT INTO webhook_queue
        (event_key, conversation_id, payload, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(event_key) DO NOTHING`)
        .run(eventKey, conversationId, payload, Date.now());
    return result.changes === 1;
}

export function nextQueuedWebhook(now = Date.now()): QueuedWebhook | undefined {
    // Do not allow a later event for the same conversation to pass a failed one.
    return db.prepare(`SELECT q.id, q.conversation_id, q.payload, q.attempts, q.text_sent, q.text_chunk_index, q.attachment_index
        FROM webhook_queue q WHERE q.state = 'pending' AND q.inflight IS NULL AND q.next_attempt_at <= ?
        AND NOT EXISTS (SELECT 1 FROM webhook_queue older WHERE older.state = 'pending'
            AND older.conversation_id = q.conversation_id AND older.id < q.id)
        ORDER BY q.id LIMIT 1`).get(now) as QueuedWebhook | undefined;
}

export function completeQueuedWebhook(id: number): void {
    // Remove the payload from the live row; SQLite files/WAL may retain old bytes.
    db.prepare(`UPDATE webhook_queue SET state = 'delivered', payload = NULL, delivered_at = ? WHERE id = ?`)
        .run(Date.now(), id);
}

export function markQueuedTextSent(id: number): void {
    db.prepare(`UPDATE webhook_queue SET text_sent = 1 WHERE id = ? AND state = 'pending'`).run(id);
}

export function markQueuedTextChunkSent(id: number, nextIndex: number): void {
    db.prepare(`UPDATE webhook_queue SET text_chunk_index = ? WHERE id = ? AND state = 'pending'`).run(nextIndex, id);
}

// Commit the local message mapping and progress as one unit. Telegram is an
// external system, so a crash before this transaction can still duplicate.
export function recordQueuedTextChunkSent(id: number, nextIndex: number, telegramMessageId: number,
    conversationId: number, accountId: number, chatwootMessageId?: number): void {
    db.transaction(() => {
        insertMappingStmt.run(telegramMessageId, conversationId, accountId, chatwootMessageId);
        const r = db.prepare(`UPDATE webhook_queue SET text_chunk_index = ?, inflight = NULL WHERE id = ? AND state = 'pending'`).run(nextIndex, id);
        if (r.changes !== 1) throw new Error('Pending queue item not found');
    })();
}

export function markQueuedAttachmentSent(id: number, nextIndex: number): void {
    db.prepare(`UPDATE webhook_queue SET attachment_index = ? WHERE id = ? AND state = 'pending'`).run(nextIndex, id);
}

// The returned Telegram message ID and the queue checkpoint must be committed
// together. A failure rolls back both, preserving the original pending item.
export function recordQueuedAttachmentSent(id: number, nextIndex: number, telegramMessageId: number,
    conversationId: number, accountId: number, chatwootMessageId?: number): void {
    db.transaction(() => {
        insertMappingStmt.run(telegramMessageId, conversationId, accountId, chatwootMessageId);
        const result = db.prepare(`UPDATE webhook_queue SET attachment_index = ?, inflight = NULL WHERE id = ? AND state = 'pending'`).run(nextIndex, id);
        if (result.changes !== 1) throw new Error('Pending queue item not found');
    })();
}

export function beginQueuedSend(id: number, kind: string): void {
    const r = db.prepare(`UPDATE webhook_queue SET inflight = ? WHERE id = ? AND state = 'pending' AND inflight IS NULL`).run(kind, id);
    if (r.changes !== 1) throw new Error('Queue operation already in flight');
}

export function clearQueuedSend(id: number): void {
    db.prepare(`UPDATE webhook_queue SET inflight = NULL WHERE id = ? AND state = 'pending'`).run(id);
}

export function recordQueuedTopic(id: number, conversationId: number, accountId: number, topicId: number, name: string): void {
    db.transaction(() => {
        insertTopicStmt.run(conversationId, accountId, topicId, name);
        const r = db.prepare(`UPDATE webhook_queue SET inflight = NULL WHERE id = ? AND state = 'pending'`).run(id);
        if (r.changes !== 1) throw new Error('Pending queue item not found');
    })();
}

export function recordOutgoingSource(sourceId: string, accountId: number, conversationId: number, senderId: number,
    telegramChatId: string, telegramMessageId: string): boolean {
    const r = db.prepare(`INSERT INTO bridge_outgoing_sources(source_id,account_id,conversation_id,sender_id,telegram_chat_id,telegram_message_id,created_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(telegram_chat_id,telegram_message_id) DO NOTHING`)
        .run(sourceId, accountId, conversationId, senderId, telegramChatId, telegramMessageId, Date.now());
    return r.changes === 1;
}

export function setOutgoingSourceStatus(sourceId: string, status: 'confirmed' | 'rejected'): void {
    db.prepare(`UPDATE bridge_outgoing_sources SET status = ? WHERE source_id = ?`).run(status, sourceId);
}

export function matchesOutgoingSource(sourceId: string, accountId: number, conversationId: number, senderId: number): boolean {
    return !!db.prepare(`SELECT 1 FROM bridge_outgoing_sources WHERE source_id=? AND account_id=? AND conversation_id=? AND sender_id=?`)
        .get(sourceId, accountId, conversationId, senderId);
}

export function pendingOutgoingSources(): string[] {
    return (db.prepare(`SELECT source_id FROM bridge_outgoing_sources WHERE status = 'pending'`).all() as {source_id: string}[]).map(row => row.source_id);
}

export function retryQueuedWebhook(id: number, attempts: number): void {
    const delay = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
    db.prepare(`UPDATE webhook_queue SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?`)
        .run(Date.now() + delay, id);
}

export function webhookQueueHealth(activeId?: number): { pending: number; failed: number } {
    const result = db.prepare(`SELECT COUNT(*) AS pending,
        COALESCE(SUM(CASE WHEN attempts > 0 OR (inflight IS NOT NULL AND id != ?) THEN 1 ELSE 0 END), 0) AS failed
        FROM webhook_queue WHERE state = 'pending'`).get(activeId ?? 0) as { pending: number; failed: number };
    return result;
}

// ============ Shutdown ============

/** 优雅关闭 SQLite 连接（flush WAL，避免日志写半截）。 */
export function closeDb() {
    try {
        db.close();
        log.info('Database closed');
    } catch (err) {
        log.warn('Failed to close database', { error: String(err) });
    } finally {
        releaseOwnership?.();
        releaseOwnership = undefined;
    }
}
