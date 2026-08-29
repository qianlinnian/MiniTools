import assert from "node:assert/strict";
import test from "node:test";

import { ConversationService } from "../src/conversation.mjs";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";

test("injects only relevant memory and scoped knowledge", () => {
  const storage = new SqliteStore({ databasePath: ":memory:" });
  storage.addMemory("user-1", "用户喜欢简洁的项目周报");
  storage.addMemory("user-1", "用户养了一只橘猫");
  storage.addKnowledgeEntry({
    scopeId: "user:user-1",
    title: "项目周报规范",
    content: "周报必须包含进展、风险和下一步。",
    createdBy: "user-1",
  });
  const service = new ConversationService({
    storage,
    deepseek: { chat: async () => ({ content: "摘要" }) },
    model: "flash",
  });

  const messages = service.messagesFor({
    scopeId: "chat-1",
    ownerId: "user-1",
    knowledgeScopeId: "user:user-1",
    userText: "帮我写简洁的项目周报，说明风险",
  });
  const references = messages.filter((item) => item.role === "system")[1].content;
  assert.match(references, /喜欢简洁的项目周报/);
  assert.match(references, /周报必须包含进展、风险和下一步/);
  assert.doesNotMatch(references, /橘猫/);
  storage.close();
});

test("summarizes old messages and retains the recent window", async () => {
  const storage = new SqliteStore({ databasePath: ":memory:" });
  for (let index = 1; index <= 4; index += 1) {
    storage.addExchange("chat-1", `问题${index}`, `回答${index}`);
  }
  let summaryRequest;
  const service = new ConversationService({
    storage,
    deepseek: {
      chat: async (request) => {
        summaryRequest = request;
        return { content: "用户连续询问了四个问题。" };
      },
    },
    model: "flash",
    settings: {
      summaryTriggerMessages: 6,
      summaryRetainMessages: 2,
    },
  });

  assert.equal(await service.compactIfNeeded("chat-1"), true);
  assert.match(summaryRequest.messages[1].content, /问题1/);
  assert.doesNotMatch(summaryRequest.messages[1].content, /问题4/);
  assert.equal(storage.countMessages("chat-1"), 2);
  assert.equal(storage.getConversation("chat-1").summary, "用户连续询问了四个问题。");
  storage.close();
});
