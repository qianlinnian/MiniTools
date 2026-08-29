import assert from "node:assert/strict";
import test from "node:test";

import { parseInterval } from "../src/monitoring/interval.mjs";
import { createNotificationService } from "../src/monitoring/notification-service.mjs";
import { fetchPageSnapshot, isPublicIp } from "../src/monitoring/page-fetcher.mjs";
import { createSqliteStore } from "../src/storage/sqlite-store.mjs";

test("监控间隔和私网地址校验", () => {
  assert.equal(parseInterval("30m"), 1_800);
  assert.equal(parseInterval("2小时"), 7_200);
  assert.equal(parseInterval("30s"), null);
  assert.equal(isPublicIp("127.0.0.1"), false);
  assert.equal(isPublicIp("192.168.1.2"), false);
  assert.equal(isPublicIp("8.8.8.8"), true);
});

test("HTML 页面能按 CSS 选择器生成稳定指纹", async () => {
  const fetchImpl = async () => new Response(
    "<html><body><main><h1>标题</h1><p>正文</p></main><footer>忽略</footer></body></html>",
    { status: 200, headers: { "content-type": "text/html" } },
  );
  // 使用公网 IP 避免测试依赖 DNS；fetch 本身由桩函数接管，不访问网络。
  const snapshot = await fetchPageSnapshot("https://8.8.8.8/page", {
    selector: "main",
    fetchImpl,
  });
  assert.match(snapshot.content, /标题/);
  assert.doesNotMatch(snapshot.content, /忽略/);
  assert.equal(snapshot.hash.length, 64);
});

test("SQLite 通知发件箱支持幂等、领取和完成", () => {
  const storage = createSqliteStore({ databasePath: ":memory:" });
  storage.bindDefaultNotificationRecipient({ chatId: "chat-1", userId: "user-1" });
  const first = storage.enqueueNotification({ title: "提醒", body: "内容", idempotencyKey: "same" });
  const second = storage.enqueueNotification({ title: "提醒", body: "内容", idempotencyKey: "same" });
  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  const job = storage.claimDueNotification();
  assert.equal(job.chat_id, "chat-1");
  assert.equal(job.attempts, 1);
  storage.completeNotification(job.id);
  assert.equal(storage.listNotifications({ limit: 1 })[0].status, "sent");
  storage.close();
});

test("通知服务会把队列消息主动发送到 chatId", async () => {
  const storage = createSqliteStore({ databasePath: ":memory:" });
  storage.bindDefaultNotificationRecipient({ chatId: "chat-1" });
  storage.enqueueNotification({ title: "测试", body: "手机提醒" });
  const sent = [];
  const service = createNotificationService({
    storage,
    send: async (chatId, markdown) => sent.push({ chatId, markdown }),
  });
  await service.runOnce();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "chat-1");
  assert.match(sent[0].markdown, /手机提醒/);
  storage.close();
});
