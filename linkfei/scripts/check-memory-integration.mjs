import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, assertDeepSeekConfig } from "../src/config.mjs";
import { ConversationService } from "../src/conversation.mjs";
import { createDeepSeekClient } from "../src/deepseek.mjs";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";

const config = loadConfig();
assertDeepSeekConfig(config);
const deepseek = createDeepSeekClient(config.deepseek);
const directory = mkdtempSync(join(tmpdir(), "linkfei-memory-check-"));
const databasePath = join(directory, "integration.sqlite");

try {
  const storage = new SqliteStore({ databasePath });
  for (let index = 1; index <= 3; index += 1) {
    storage.addExchange(
      "integration-chat",
      `用户在第 ${index} 轮确认项目代号 LF-INTEGRATION-${index}。`,
      `助手已记录第 ${index} 轮的项目代号。`,
    );
  }
  const service = new ConversationService({
    storage,
    deepseek,
    model: config.deepseek.models.flash,
    settings: {
      summaryTriggerMessages: 4,
      summaryRetainMessages: 2,
    },
  });
  assert.equal(await service.compactIfNeeded("integration-chat"), true);
  const summary = storage.getConversation("integration-chat").summary;
  assert.ok(summary.length > 0);
  assert.equal(storage.countMessages("integration-chat"), 2);
  storage.close();

  const reopened = new SqliteStore({ databasePath });
  assert.equal(reopened.getConversation("integration-chat").summary, summary);
  assert.equal(reopened.countMessages("integration-chat"), 2);
  reopened.close();

  console.log("[linkfei] 真实摘要、SQLite 持久化及重开恢复验证通过。", {
    summaryChars: summary.length,
    retainedMessages: 2,
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
