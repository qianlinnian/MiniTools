import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexBridge, redact } from "../src/codex/bridge.mjs";
import { CodexClient } from "../src/codex/client.mjs";
import { createSqliteStore } from "../src/storage/sqlite-store.mjs";
import { createBot } from "../src/bot.mjs";

class FakeClient extends EventEmitter {
  calls = []; responses = []; serial = 0; threadReads = new Map();
  async start() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "model/list") return { data: [{ model: "test-model", isDefault: true }] };
    if (method === "thread/start") return { thread: { id: `thread-${++this.serial}` } };
    if (method === "turn/start") return { turn: { id: `turn-${++this.serial}` } };
    if (method === "thread/read") return this.threadReads.get(params.threadId) || { thread: { turns: [] } };
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  write(message) { this.responses.push(message); }
  close() {}
}
function setup(t) {
  const storage = createSqliteStore({ databasePath: ":memory:" });
  const client = new FakeClient();
  const message = { chatType: "p2p", senderId: "owner", chatId: "private" };
  const config = { enabled: true, ownerId: "owner", chatId: "private", projects: { demo: process.cwd() } };
  const bridge = new CodexBridge({ storage, client, config });
  t.after(() => { bridge.close(); storage.close(); });
  const task = () => storage.db.prepare("SELECT * FROM codex_remote_tasks ORDER BY id DESC LIMIT 1").get();
  return { storage, client, message, bridge, task };
}
test("remote commands require both pinned user and private chat, before any Codex call", async t => {
  const { bridge, message, client } = setup(t);
  for (const overrides of [{ chatType: "group" }, { senderId: "other" }, { chatId: "other" }]) {
    assert.match(await bridge.handle({ ...message, ...overrides }, "/codex new demo | execute"), /没有控制权限/);
  }
  assert.equal(client.calls.length, 0);
  assert.match(await bridge.handle(message, "/codex new ../../outside | execute"), /未授权/);
});
test("new task uses constrained working directory, continued messages steer and stop targets exact turn", async t => {
  const { bridge, message, client, task } = setup(t);
  assert.match(await bridge.handle(message, "/codex new demo | hello"), /已提交/);
  const start = client.calls.find(call => call.method === "thread/start");
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(start.params.approvalPolicy, "on-request");
  assert.match(await bridge.handle(message, "/codex send 1 | add context"), /补充要求/);
  assert.equal(client.calls.at(-1).params.expectedTurnId, task().turn_id);
  assert.match(await bridge.handle(message, "/codex stop 1"), /请求停止/);
  assert.equal(client.calls.at(-1).method, "turn/interrupt");
  assert.equal(client.calls.at(-1).params.turnId, task().turn_id);
});
test("simultaneous submissions cannot create duplicate active tasks", async t => {
  const { bridge, message, client } = setup(t);
  const result = await Promise.all([bridge.handle(message, "/codex new demo | one"), bridge.handle(message, "/codex new demo | two")]);
  assert.match(result[1], /已有未结束/);
  assert.equal(client.calls.filter(call => call.method === "turn/start").length, 1);
});
test("completion and reliable result queue persist once, followup starts a new turn", async t => {
  const { bridge, message, client, task, storage } = setup(t);
  await bridge.handle(message, "/codex new demo | hello");
  const current = task();
  client.emit("message", { method: "item/completed", params: { threadId: current.thread_id, item: { type: "agentMessage", text: "结果" } } });
  const completed = { method: "turn/completed", params: { threadId: current.thread_id, turn: { id: current.turn_id, status: "completed" } } };
  client.emit("message", completed); client.emit("message", completed);
  assert.equal(task().status, "completed");
  assert.equal(storage.listNotifications().length, 1);
  assert.match(storage.listNotifications()[0].body, /结果/);
  await bridge.handle(message, "/codex send 1 | next");
  assert.equal(client.calls.at(-1).method, "turn/start");
});
test("status refreshes desktop-side turns, and the poller reports only later desktop completions", async t => {
  const { bridge, message, client, task, storage } = setup(t);
  await bridge.handle(message, "/codex new demo | hello");
  const first = task();
  client.threadReads.set(first.thread_id, { thread: { status: { type: "idle" }, turns: [{
    id: "desktop-1", status: "completed", startedAt: 1,
    items: [{ type: "agentMessage", text: "桌面端第一条结果" }],
  }] } });
  const status = await bridge.handle(message, "/codex status 1");
  assert.match(status, /桌面端第一条结果/);
  assert.equal(task().status, "completed");
  assert.equal(storage.listNotifications().length, 0);
  client.threadReads.set(first.thread_id, { thread: { status: { type: "idle" }, turns: [{
    id: "desktop-1", status: "completed", startedAt: 1, items: [{ type: "agentMessage", text: "旧结果" }],
  }, {
    id: "desktop-2", status: "completed", startedAt: 2, items: [{ type: "agentMessage", text: "桌面端新结果" }],
  }] } });
  await bridge.syncAll({ notify: true });
  assert.equal(task().last_synced_turn_id, "desktop-2");
  assert.match(task().output, /桌面端新结果/);
  assert.equal(storage.listNotifications().length, 1);
  await bridge.syncAll({ notify: true });
  assert.equal(storage.listNotifications().length, 1);
});
test("single-use approvals require matching owner and never grant session-wide rights", async t => {
  const { bridge, message, client, task } = setup(t);
  await bridge.handle(message, "/codex new demo | hello");
  client.emit("message", { id: 88, method: "item/commandExecution/requestApproval", params: { threadId: task().thread_id, command: "npm test" } });
  const [code] = bridge.approvals.keys();
  assert.equal(task().status, "waiting");
  await bridge.handle({ ...message, senderId: "other" }, `/codex approve ${code}`);
  assert.equal(client.responses.length, 0);
  await bridge.handle(message, `/codex approve ${code}`);
  assert.deepEqual(client.responses[0], { id: 88, result: { decision: "accept" } });
  assert.match(await bridge.handle(message, `/codex approve ${code}`), /无效/);
});
test("continuing an older task cannot bypass the single-active-task limit", async t => {
  const { bridge, message, client, task } = setup(t);
  await bridge.handle(message, "/codex new demo | first");
  client.emit("message", { method: "turn/completed", params: { threadId: task().thread_id, turn: { id: task().turn_id, status: "completed" } } });
  await bridge.handle(message, "/codex new demo | second");
  const before = client.calls.length;
  assert.match(await bridge.handle(message, "/codex send 1 | continue first"), /已有未结束任务/);
  assert.equal(client.calls.length, before);
});
test("sensitive commands and unsupported interactive requests are not approved", async t => {
  const { bridge, message, client, task, storage } = setup(t);
  await bridge.handle(message, "/codex new demo | hello");
  client.emit("message", { id: 4, method: "item/commandExecution/requestApproval", params: { threadId: task().thread_id, command: "ssh -pw 'private-password' host" } });
  assert.equal(client.responses[0].result.decision, "decline");
  assert.doesNotMatch(storage.listNotifications()[0].body, /private-password/);
  client.emit("message", { id: 5, method: "item/tool/requestUserInput", params: { threadId: task().thread_id } });
  assert.ok(client.responses[1].error);
});
test("restart marks in-flight work unknown, never replays it automatically", async t => {
  const { bridge, message, client, task } = setup(t);
  await bridge.handle(message, "/codex new demo | hello");
  bridge.start();
  assert.equal(task().status, "unknown");
  const count = client.calls.filter(call => call.method === "turn/start").length;
  assert.match(await bridge.handle(message, "/codex send 1 | repeat"), /不确定/);
  assert.equal(client.calls.filter(call => call.method === "turn/start").length, count);
});
test("transport disconnect clears approval codes and flags uncertainty", async t => {
  const { bridge, message, client, task } = setup(t);
  await bridge.handle(message, "/codex new demo | hello");
  client.emit("disconnect");
  assert.equal(task().status, "unknown");
  assert.equal(bridge.approvals.size, 0);
});
test("credentials in outputs are redacted", () => {
  assert.equal(redact("token=abcdefghijk"), "token=[已隐藏]");
  assert.doesNotMatch(redact("Bearer abcdefghijklmnop"), /abcdefghijklmnop/);
});
test("Codex routing bypasses DeepSeek and still deduplicates Feishu events", async t => {
  const { storage, message } = setup(t);
  let count = 0; const replies = [];
  const bot = createBot({ storage, codexBridge: { handle: async () => { count++; return "ok"; } },
    deepseek: {}, config: { deepseek: { models: { flash: "unused" } }, storage: {} },
    channel: { send: async (...args) => replies.push(args) } });
  const incoming = { ...message, messageId: "event", content: JSON.stringify({ text: "/codex projects" }) };
  await bot.processMessage(incoming); await bot.processMessage(incoming);
  assert.equal(count, 1); assert.equal(replies.length, 1);
});
test("JSON-RPC transport correlates concurrent replies and rejects requests on exit", async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const client = new CodexClient({ spawnImpl: () => child, timeoutMs: 1000 });
  child.stdin.on("data", bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method === "initialize") child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
  });
  await client.start();
  const one = client.request("one"), two = client.request("two");
  child.stdout.write(JSON.stringify({ id: 3, result: "second" }) + "\n");
  child.stdout.write(JSON.stringify({ id: 2, result: "first" }) + "\n");
  assert.deepEqual(await Promise.all([one, two]), ["first", "second"]);
  const pending = client.request("pending"); child.emit("exit", 1);
  await assert.rejects(pending, /连接已断开/); client.close();
});
