import assert from "node:assert/strict";
import test from "node:test";

import { createBot } from "../src/bot.mjs";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";

function testConfig() {
  return {
    deepseek: {
      defaultTier: "flash",
      models: { flash: "flash-model", pro: "pro-model" },
    },
    feishu: { docBaseUrl: "https://feishu.cn/docx" },
    storage: {
      recentMessageLimit: 16,
      contextCharBudget: 24_000,
      summaryTriggerMessages: 24,
      summaryRetainMessages: 10,
    },
  };
}

function message(messageId, content, overrides = {}) {
  return {
    messageId,
    chatId: "chat-1",
    chatType: "p2p",
    senderId: "user-1",
    content: JSON.stringify({ text: content }),
    ...overrides,
  };
}

test("processes a Feishu message once and persists its exchange", async () => {
  const sent = [];
  const storage = new SqliteStore({ databasePath: ":memory:" });
  const bot = createBot({
    channel: {
      send: async (...args) => sent.push(args),
      rawClient: {},
    },
    deepseek: {
      chat: async ({ messages }) => ({
        content: `收到：${messages.at(-1).content}`,
      }),
    },
    storage,
    config: testConfig(),
  });

  const incoming = message("message-1", "你好");
  await bot.processMessage(incoming);
  await bot.processMessage(incoming);

  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].markdown, "收到：你好");
  assert.equal(storage.countMessages("chat-1"), 2);
  storage.close();
});

test("keeps long-term memory after resetting a conversation", async () => {
  const sent = [];
  const storage = new SqliteStore({ databasePath: ":memory:" });
  const bot = createBot({
    channel: {
      send: async (...args) => sent.push(args),
      rawClient: {},
    },
    deepseek: { chat: async () => ({ content: "回答" }) },
    storage,
    config: testConfig(),
  });

  await bot.processMessage(message("message-1", "/remember 我喜欢简洁回答"));
  storage.addExchange("chat-1", "旧问题", "旧回答");
  await bot.processMessage(message("message-2", "/reset"));
  await bot.processMessage(message("message-3", "/memory"));

  assert.equal(storage.countMessages("chat-1"), 0);
  assert.equal(storage.listMemories("user-1").length, 1);
  assert.match(sent.at(-1)[1].markdown, /我喜欢简洁回答/);
  storage.close();
});

test("isolates private memories between Feishu senders", async () => {
  const sent = [];
  const storage = new SqliteStore({ databasePath: ":memory:" });
  const bot = createBot({
    channel: {
      send: async (...args) => sent.push(args),
      rawClient: {},
    },
    deepseek: { chat: async () => ({ content: "回答" }) },
    storage,
    config: testConfig(),
  });

  await bot.processMessage(message("message-1", "/remember 私人信息"));
  await bot.processMessage(
    message("message-2", "/memory", { senderId: "user-2" }),
  );

  assert.equal(storage.listMemories("user-2").length, 0);
  assert.match(sent.at(-1)[1].markdown, /没有保存/);
  assert.doesNotMatch(sent.at(-1)[1].markdown, /私人信息/);
  storage.close();
});

test("never exposes or injects personal memory in a group chat", async () => {
  const sent = [];
  let modelMessages;
  const storage = new SqliteStore({ databasePath: ":memory:" });
  storage.addMemory("user-1", "我的私人项目代号是 SECRET-42");
  const bot = createBot({
    channel: {
      send: async (...args) => sent.push(args),
      rawClient: {},
    },
    deepseek: {
      chat: async ({ messages }) => {
        modelMessages = messages;
        return { content: "群聊回答" };
      },
    },
    storage,
    config: testConfig(),
  });

  await bot.processMessage(
    message("message-1", "项目代号是什么？", { chatType: "group" }),
  );
  assert.doesNotMatch(
    modelMessages.map((item) => item.content).join("\n"),
    /SECRET-42/,
  );

  await bot.processMessage(
    message("message-2", "/memory", { chatType: "group" }),
  );
  assert.match(sent.at(-1)[1].markdown, /只能在.*私聊/);
  assert.doesNotMatch(sent.at(-1)[1].markdown, /SECRET-42/);
  storage.close();
});
