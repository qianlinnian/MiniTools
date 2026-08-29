import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteStore } from "../src/storage/sqlite-store.mjs";

test("persists conversations across database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "linkfei-store-"));
  const databasePath = join(directory, "linkfei.sqlite");
  try {
    const first = new SqliteStore({ databasePath });
    first.addExchange("chat-1", "问题", "回答");
    first.close();

    const second = new SqliteStore({ databasePath });
    assert.deepEqual(
      second.getRecentMessages("chat-1").map(({ role, content }) => ({
        role,
        content,
      })),
      [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回答" },
      ],
    );
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deduplicates events even when the first handling failed", () => {
  const store = new SqliteStore({ databasePath: ":memory:" });
  assert.equal(store.claimEvent("message-1", "chat-1"), true);
  store.failEvent("message-1", "temporary error");
  assert.equal(store.claimEvent("message-1", "chat-1"), false);
  store.close();
});

test("recovers interrupted document tasks and keeps completed tasks", () => {
  const store = new SqliteStore({ databasePath: ":memory:" });
  const interrupted = store.createDocumentTask({
    chatId: "chat-1",
    messageId: "message-1",
    userId: "user-1",
    title: "中断任务",
    prompt: "正文",
  });
  const completed = store.createDocumentTask({
    chatId: "chat-1",
    messageId: "message-2",
    userId: "user-1",
    title: "完成任务",
    prompt: "正文",
  });
  store.updateDocumentTask(completed, { status: "completed", url: "https://feishu.cn/docx/1" });

  assert.equal(store.recoverInterruptedDocumentTasks(), 1);
  assert.equal(store.getDocumentTaskByMessageId("message-1").id, interrupted);
  assert.equal(store.getDocumentTaskByMessageId("message-1").status, "interrupted");
  assert.equal(store.getDocumentTaskByMessageId("message-2").status, "completed");
  store.close();
});

test("isolates memories by owner and deletes only the selected memory", () => {
  const store = new SqliteStore({ databasePath: ":memory:" });
  const firstId = store.addMemory("user-1", "我偏好简洁的回答");
  store.addMemory("user-2", "另一个用户的秘密");

  assert.equal(store.listMemories("user-1").length, 1);
  assert.equal(store.searchMemories("user-1", "回答")[0].id, firstId);
  assert.equal(store.deleteMemory("user-1", String(firstId)), 1);
  assert.equal(store.listMemories("user-1").length, 0);
  assert.equal(store.listMemories("user-2").length, 1);
  store.close();
});

test("chunks and retrieves scoped knowledge with sparse vector similarity", () => {
  const store = new SqliteStore({ databasePath: ":memory:" });
  const entryId = store.addKnowledgeEntry({
    scopeId: "chat:1",
    title: "飞书权限说明",
    content: "创建飞书文档需要开通新版文档权限，并发布应用版本。",
    createdBy: "user-1",
  });
  store.addKnowledgeEntry({
    scopeId: "chat:2",
    title: "其他群知识",
    content: "不应被 chat:1 检索到。",
    createdBy: "user-2",
  });

  const results = store.searchKnowledge("chat:1", "飞书文档权限");
  assert.equal(results[0].entry_id, entryId);
  assert.equal(store.listKnowledgeEntries("chat:1").length, 1);
  assert.equal(store.deleteKnowledgeEntry("chat:1", entryId), 1);
  assert.equal(store.searchKnowledge("chat:1", "飞书文档权限").length, 0);
  store.close();
});
