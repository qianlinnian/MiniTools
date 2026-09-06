import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { rankByRelevance, splitKnowledgeContent } from "../retrieval.mjs";
import { Storage } from "./storage.mjs";

function now() {
  return new Date().toISOString();
}

function asNumber(value) {
  return typeof value === "bigint" ? Number(value) : value;
}

export class SqliteStore extends Storage {
  constructor({ databasePath = "data/linkfei.sqlite" } = {}) {
    super();
    this.databasePath =
      databasePath === ":memory:" ? databasePath : resolve(databasePath);
    if (this.databasePath !== ":memory:") {
      mkdirSync(dirname(this.databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (this.databasePath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    }
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        scope_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES conversations(scope_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_scope_id_id
        ON messages(scope_id, id);

      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'done', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_processed_events_updated_at
        ON processed_events(updated_at);

      CREATE TABLE IF NOT EXISTS document_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        document_id TEXT,
        url TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_document_tasks_chat_created
        ON document_tasks(chat_id, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_document_tasks_message_id
        ON document_tasks(message_id);

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_owner_id
        ON memories(owner_id, id DESC);

      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_entries_scope_id
        ON knowledge_entries(scope_id, id DESC);
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY (entry_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_entry_id
        ON knowledge_chunks(entry_id, position);

      CREATE TABLE IF NOT EXISTS notification_recipients (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        chat_id TEXT NOT NULL,
        user_id TEXT,
        label TEXT NOT NULL DEFAULT '默认飞书收件人',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        url TEXT,
        level TEXT NOT NULL DEFAULT 'info',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'retry', 'sending', 'sent', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
        ON notification_outbox(status, next_attempt_at, id);

      CREATE TABLE IF NOT EXISTS page_monitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        selector TEXT,
        interval_seconds INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'active'
          CHECK (state IN ('active', 'paused', 'checking')),
        last_hash TEXT,
        last_excerpt TEXT,
        last_checked_at TEXT,
        next_check_at TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        error_notified INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_page_monitors_due
        ON page_monitors(state, next_check_at, id);
    `);
  }

  ensureConversation(scopeId) {
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO conversations(scope_id, created_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scope_id) DO NOTHING
      `)
      .run(scopeId, timestamp, timestamp);
  }

  getConversation(scopeId) {
    return (
      this.db
        .prepare("SELECT * FROM conversations WHERE scope_id = ?")
        .get(scopeId) || { scope_id: scopeId, summary: "" }
    );
  }

  getRecentMessages(scopeId, { limit = 16 } = {}) {
    return this.db
      .prepare(`
        SELECT id, role, content, created_at
        FROM (
          SELECT id, role, content, created_at
          FROM messages
          WHERE scope_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
        ORDER BY id ASC
      `)
      .all(scopeId, limit)
      .map((row) => ({ ...row, id: asNumber(row.id) }));
  }

  getMessagesForCompaction(scopeId, { retain = 8 } = {}) {
    return this.db
      .prepare(`
        SELECT id, role, content, created_at
        FROM messages
        WHERE scope_id = ?
          AND id NOT IN (
            SELECT id FROM messages
            WHERE scope_id = ?
            ORDER BY id DESC
            LIMIT ?
          )
        ORDER BY id ASC
      `)
      .all(scopeId, scopeId, retain)
      .map((row) => ({ ...row, id: asNumber(row.id) }));
  }

  countMessages(scopeId) {
    return asNumber(
      this.db
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE scope_id = ?")
        .get(scopeId).count,
    );
  }

  addExchange(scopeId, userText, assistantText) {
    this.ensureConversation(scopeId);
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(
        "INSERT INTO messages(scope_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      );
      insert.run(scopeId, "user", userText, timestamp);
      insert.run(scopeId, "assistant", assistantText, timestamp);
      this.db
        .prepare("UPDATE conversations SET updated_at = ? WHERE scope_id = ?")
        .run(timestamp, scopeId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  compactConversation(scopeId, summary, throughMessageId) {
    this.ensureConversation(scopeId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE conversations SET summary = ?, updated_at = ? WHERE scope_id = ?",
        )
        .run(summary, now(), scopeId);
      this.db
        .prepare("DELETE FROM messages WHERE scope_id = ? AND id <= ?")
        .run(scopeId, throughMessageId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearConversation(scopeId) {
    this.db.prepare("DELETE FROM conversations WHERE scope_id = ?").run(scopeId);
  }

  claimEvent(eventId, chatId) {
    const timestamp = now();
    const inserted = this.db
      .prepare(`
        INSERT INTO processed_events(event_id, chat_id, status, updated_at)
        VALUES (?, ?, 'processing', ?)
        ON CONFLICT(event_id) DO NOTHING
      `)
      .run(eventId, chatId, timestamp);
    if (asNumber(inserted.changes) === 1) return true;

    return false;
  }

  completeEvent(eventId) {
    this.db
      .prepare(
        "UPDATE processed_events SET status = 'done', error = NULL, updated_at = ? WHERE event_id = ?",
      )
      .run(now(), eventId);
  }

  failEvent(eventId, error) {
    this.db
      .prepare(
        "UPDATE processed_events SET status = 'failed', error = ?, updated_at = ? WHERE event_id = ?",
      )
      .run(String(error || "未知错误").slice(0, 2_000), now(), eventId);
  }

  pruneEvents({ olderThanDays = 7 } = {}) {
    const threshold = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return asNumber(
      this.db
        .prepare("DELETE FROM processed_events WHERE updated_at < ?")
        .run(threshold).changes,
    );
  }

  createDocumentTask({ chatId, messageId, userId, title, prompt }) {
    const timestamp = now();
    const result = this.db
      .prepare(`
        INSERT INTO document_tasks(
          chat_id, message_id, user_id, title, prompt, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'generating', ?, ?)
      `)
      .run(chatId, messageId, userId, title, prompt, timestamp, timestamp);
    return asNumber(result.lastInsertRowid);
  }

  getDocumentTaskByMessageId(messageId) {
    const row = this.db
      .prepare("SELECT * FROM document_tasks WHERE message_id = ?")
      .get(messageId);
    return row ? { ...row, id: asNumber(row.id) } : null;
  }

  updateDocumentTask(id, { status, documentId, url, error } = {}) {
    const current = this.db
      .prepare("SELECT * FROM document_tasks WHERE id = ?")
      .get(id);
    if (!current) throw new Error(`文档任务 ${id} 不存在。`);
    this.db
      .prepare(`
        UPDATE document_tasks
        SET status = ?, document_id = ?, url = ?, error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        status ?? current.status,
        documentId ?? current.document_id,
        url ?? current.url,
        error ?? current.error,
        now(),
        id,
      );
  }

  listDocumentTasks(chatId, { limit = 10 } = {}) {
    return this.db
      .prepare(`
        SELECT * FROM document_tasks
        WHERE chat_id = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(chatId, limit)
      .map((row) => ({ ...row, id: asNumber(row.id) }));
  }

  recoverInterruptedDocumentTasks() {
    return asNumber(
      this.db
        .prepare(`
          UPDATE document_tasks
          SET status = 'interrupted', error = '机器人重启导致任务中断', updated_at = ?
          WHERE status IN ('generating', 'writing')
        `)
        .run(now()).changes,
    );
  }

  addMemory(ownerId, content) {
    const timestamp = now();
    const result = this.db
      .prepare(
        "INSERT INTO memories(owner_id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(ownerId, content, timestamp, timestamp);
    return asNumber(result.lastInsertRowid);
  }

  listMemories(ownerId, { limit = 50 } = {}) {
    return this.db
      .prepare(
        "SELECT * FROM memories WHERE owner_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(ownerId, limit)
      .map((row) => ({ ...row, id: asNumber(row.id) }));
  }

  deleteMemory(ownerId, selector) {
    if (selector === "all") {
      return asNumber(
        this.db.prepare("DELETE FROM memories WHERE owner_id = ?").run(ownerId)
          .changes,
      );
    }
    const id = Number.parseInt(selector, 10);
    if (!Number.isInteger(id)) return 0;
    return asNumber(
      this.db
        .prepare("DELETE FROM memories WHERE owner_id = ? AND id = ?")
        .run(ownerId, id).changes,
    );
  }

  searchMemories(ownerId, query, { limit = 5 } = {}) {
    const memories = this.listMemories(ownerId, { limit: 200 });
    return rankByRelevance(memories, query, {
      textOf: (item) => item.content,
      limit,
    }).map(({ item, score }) => ({ ...item, score }));
  }

  addKnowledgeEntry({ scopeId, title, content, createdBy }) {
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(`
          INSERT INTO knowledge_entries(
            scope_id, title, content, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(scopeId, title, content, createdBy, timestamp, timestamp);
      const entryId = asNumber(result.lastInsertRowid);
      const insertChunk = this.db.prepare(
        "INSERT INTO knowledge_chunks(entry_id, position, content) VALUES (?, ?, ?)",
      );
      splitKnowledgeContent(content).forEach((chunk, position) => {
        insertChunk.run(entryId, position, chunk);
      });
      this.db.exec("COMMIT");
      return entryId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listKnowledgeEntries(scopeId, { limit = 50 } = {}) {
    return this.db
      .prepare(`
        SELECT id, title, created_by, created_at, updated_at
        FROM knowledge_entries
        WHERE scope_id = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(scopeId, limit)
      .map((row) => ({ ...row, id: asNumber(row.id) }));
  }

  deleteKnowledgeEntry(scopeId, id) {
    return asNumber(
      this.db
        .prepare("DELETE FROM knowledge_entries WHERE scope_id = ? AND id = ?")
        .run(scopeId, id).changes,
    );
  }

  searchKnowledge(scopeId, query, { limit = 5 } = {}) {
    const rows = this.db
      .prepare(`
        SELECT
          c.id AS chunk_id,
          c.position,
          c.content,
          e.id AS entry_id,
          e.title
        FROM knowledge_chunks c
        JOIN knowledge_entries e ON e.id = c.entry_id
        WHERE e.scope_id = ?
      `)
      .all(scopeId)
      .map((row) => ({
        ...row,
        chunk_id: asNumber(row.chunk_id),
        entry_id: asNumber(row.entry_id),
      }));
    return rankByRelevance(rows, query, {
      textOf: (item) => `${item.title}\n${item.content}`,
      limit,
    }).map(({ item, score }) => ({ ...item, score }));
  }

  bindDefaultNotificationRecipient({ chatId, userId = null, label } = {}) {
    if (!chatId) throw new Error("缺少飞书 chatId。");
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO notification_recipients(
          id, chat_id, user_id, label, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          chat_id = excluded.chat_id,
          user_id = excluded.user_id,
          label = excluded.label,
          updated_at = excluded.updated_at
      `)
      .run(chatId, userId, label || "默认飞书收件人", timestamp, timestamp);
    return this.getDefaultNotificationRecipient();
  }

  getDefaultNotificationRecipient() {
    return this.db
      .prepare("SELECT * FROM notification_recipients WHERE id = 1")
      .get() || null;
  }

  enqueueNotification({
    chatId,
    title,
    body,
    url = null,
    level = "info",
    idempotencyKey = null,
  }) {
    const recipient = chatId
      ? { chat_id: chatId }
      : this.getDefaultNotificationRecipient();
    if (!recipient) {
      throw new Error("尚未绑定默认飞书收件人，请先私聊机器人发送 /notify bind。");
    }
    const timestamp = now();
    const result = this.db
      .prepare(`
        INSERT INTO notification_outbox(
          chat_id, title, body, url, level, status, attempts,
          next_attempt_at, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .run(
        recipient.chat_id,
        String(title || "LinkFei 提醒").slice(0, 200),
        String(body || "").slice(0, 20_000),
        url,
        level,
        timestamp,
        idempotencyKey,
        timestamp,
        timestamp,
      );
    if (asNumber(result.changes) === 1) {
      return { id: asNumber(result.lastInsertRowid), queued: true };
    }
    const existing = idempotencyKey
      ? this.db
          .prepare("SELECT id, status FROM notification_outbox WHERE idempotency_key = ?")
          .get(idempotencyKey)
      : null;
    return existing
      ? { id: asNumber(existing.id), status: existing.status, queued: false }
      : { id: null, queued: false };
  }

  recoverNotificationJobs() {
    return asNumber(
      this.db
        .prepare(`
          UPDATE notification_outbox
          SET status = 'retry', next_attempt_at = ?, updated_at = ?
          WHERE status = 'sending'
        `)
        .run(now(), now()).changes,
    );
  }

  claimDueNotification({ at = now() } = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`
          SELECT * FROM notification_outbox
          WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?
          ORDER BY id ASC
          LIMIT 1
        `)
        .get(at);
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(`
          UPDATE notification_outbox
          SET status = 'sending', attempts = attempts + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(now(), row.id);
      this.db.exec("COMMIT");
      return { ...row, id: asNumber(row.id), attempts: asNumber(row.attempts) + 1 };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeNotification(id) {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE notification_outbox
        SET status = 'sent', last_error = NULL, sent_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(timestamp, timestamp, id);
  }

  retryNotification(id, error, { nextAttemptAt, dead = false } = {}) {
    this.db
      .prepare(`
        UPDATE notification_outbox
        SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        dead ? "dead" : "retry",
        String(error || "发送失败").slice(0, 2_000),
        nextAttemptAt || now(),
        now(),
        id,
      );
  }

  requeueNotification(id, chatId) {
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    const timestamp = now();
    return this.db.prepare(`UPDATE notification_outbox
      SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND chat_id = ? AND status IN ('dead', 'retry')`)
      .run(timestamp, timestamp, id, chatId).changes > 0;
  }

  listNotifications({ limit = 20, chatId = null } = {}) {
    return this.db
      .prepare("SELECT * FROM notification_outbox WHERE (? IS NULL OR chat_id = ?) ORDER BY id DESC LIMIT ?")
      .all(chatId, chatId, limit)
      .map((row) => ({ ...row, id: asNumber(row.id), attempts: asNumber(row.attempts) }));
  }

  createPageMonitor({ name, url, selector = null, intervalSeconds }) {
    const timestamp = now();
    const result = this.db
      .prepare(`
        INSERT INTO page_monitors(
          name, url, selector, interval_seconds, state,
          next_check_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      `)
      .run(name, url, selector, intervalSeconds, timestamp, timestamp, timestamp);
    return this.getPageMonitor(asNumber(result.lastInsertRowid));
  }

  getPageMonitor(id) {
    const row = this.db.prepare("SELECT * FROM page_monitors WHERE id = ?").get(id);
    return row
      ? {
          ...row,
          id: asNumber(row.id),
          interval_seconds: asNumber(row.interval_seconds),
          consecutive_failures: asNumber(row.consecutive_failures),
        }
      : null;
  }

  listPageMonitors() {
    return this.db
      .prepare("SELECT * FROM page_monitors ORDER BY id ASC")
      .all()
      .map((row) => ({
        ...row,
        id: asNumber(row.id),
        interval_seconds: asNumber(row.interval_seconds),
        consecutive_failures: asNumber(row.consecutive_failures),
      }));
  }

  recoverPageMonitorJobs() {
    return asNumber(
      this.db
        .prepare(`
          UPDATE page_monitors
          SET state = 'active', next_check_at = ?, updated_at = ?
          WHERE state = 'checking'
        `)
        .run(now(), now()).changes,
    );
  }

  claimDuePageMonitor({ at = now() } = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`
          SELECT * FROM page_monitors
          WHERE state = 'active' AND next_check_at <= ?
          ORDER BY next_check_at ASC, id ASC
          LIMIT 1
        `)
        .get(at);
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare("UPDATE page_monitors SET state = 'checking', updated_at = ? WHERE id = ?")
        .run(now(), row.id);
      this.db.exec("COMMIT");
      return this.getPageMonitor(row.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completePageMonitorCheck(id, { hash, excerpt, nextCheckAt }) {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE page_monitors
        SET state = 'active', last_hash = ?, last_excerpt = ?,
            last_checked_at = ?, next_check_at = ?, consecutive_failures = 0,
            error_notified = 0, last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(hash, excerpt, timestamp, nextCheckAt, timestamp, id);
  }

  failPageMonitorCheck(id, { error, nextCheckAt }) {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE page_monitors
        SET state = 'active', last_checked_at = ?, next_check_at = ?,
            consecutive_failures = consecutive_failures + 1,
            last_error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        timestamp,
        nextCheckAt,
        String(error || "检查失败").slice(0, 2_000),
        timestamp,
        id,
      );
    return this.getPageMonitor(id);
  }

  markPageMonitorErrorNotified(id) {
    this.db
      .prepare("UPDATE page_monitors SET error_notified = 1, updated_at = ? WHERE id = ?")
      .run(now(), id);
  }

  setPageMonitorState(id, state) {
    if (!['active', 'paused'].includes(state)) throw new Error("无效的监控状态。");
    const result = this.db
      .prepare(`
        UPDATE page_monitors
        SET state = ?, next_check_at = CASE WHEN ? = 'active' THEN ? ELSE next_check_at END,
            updated_at = ?
        WHERE id = ?
      `)
      .run(state, state, now(), now(), id);
    return asNumber(result.changes) === 1;
  }

  schedulePageMonitorNow(id) {
    const result = this.db
      .prepare(`
        UPDATE page_monitors SET state = 'active', next_check_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(now(), now(), id);
    return asNumber(result.changes) === 1;
  }

  deletePageMonitor(id) {
    return asNumber(
      this.db.prepare("DELETE FROM page_monitors WHERE id = ?").run(id).changes,
    );
  }

  close() {
    this.db.close();
  }
}

export function createSqliteStore(options) {
  return new SqliteStore(options);
}
