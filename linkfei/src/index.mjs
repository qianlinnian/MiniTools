import { CodexBridge } from "./codex/bridge.mjs";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";

import { createBot } from "./bot.mjs";
import {
  assertDeepSeekConfig,
  assertFeishuConfig,
  loadConfig,
} from "./config.mjs";
import { createDeepSeekClient } from "./deepseek.mjs";
import { createNotificationService } from "./monitoring/notification-service.mjs";
import { startRuntimeControl } from "./runtime-control.mjs";
import { createSqliteStore } from "./storage/sqlite-store.mjs";
import { assertStorage } from "./storage/storage.mjs";

const config = loadConfig();
assertDeepSeekConfig(config);
assertFeishuConfig(config);

const deepseek = createDeepSeekClient(config.deepseek);
const storage = assertStorage(
  createSqliteStore({ databasePath: config.storage.databasePath }),
);
const loggerLevels = {
  fatal: LoggerLevel.fatal,
  error: LoggerLevel.error,
  warn: LoggerLevel.warn,
  info: LoggerLevel.info,
  debug: LoggerLevel.debug,
  trace: LoggerLevel.trace,
};
const channel = createLarkChannel({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  loggerLevel: loggerLevels[config.feishu.loggerLevel] ?? LoggerLevel.info,
});
const notificationService = createNotificationService({
  storage,
  send: (chatId, markdown) => channel.send(chatId, { markdown }),
});
const codexBridge = config.codex?.enabled ? new CodexBridge({ storage, config: config.codex }) : null;
const bot = createBot({ channel, deepseek, storage, notificationService, codexBridge, config });
const runtimeState = { state: "starting" };
let closing = false;
let runtimeControl;

const recovered = storage.recoverInterruptedDocumentTasks();
const pruned = storage.pruneEvents();
if (recovered || pruned) {
  console.log("[linkfei] 启动维护完成", {
    interruptedDocumentTasks: recovered,
    prunedEvents: pruned,
  });
}

channel.on("message", (message) => {
  console.log("[linkfei] 收到飞书消息", {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
  });
  // 飞书事件需要快速确认；耗时工作放入异步任务。
  void bot.processMessage(message);
});

channel.on("reject", (event) => {
  console.warn("[linkfei] 飞书消息被 SDK 策略拒绝", event);
});

channel.on("error", (error) => {
  console.error("[linkfei] 飞书通道错误", {
    code: error?.code,
    message: error?.message || "未知错误",
    context: error?.context,
  });
});

channel.on("reconnecting", () => {
  console.warn("[linkfei] 飞书长连接正在重连。");
});

channel.on("reconnected", () => {
  console.log("[linkfei] 飞书长连接已重连。");
});

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  runtimeState.state = "stopping";
  console.log(`[linkfei] 收到 ${signal}，正在关闭数据库。`);
  notificationService.stop();
  codexBridge?.close();
  await runtimeControl?.close().catch((error) => {
    console.error("[linkfei] 关闭本地控制端点失败", error?.message || error);
  });
  storage.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

runtimeControl = await startRuntimeControl({
  runtimePath: "data/linkfei-runtime.json",
  projectPath: process.cwd(),
  status: () => ({ state: runtimeState.state, codexRemoteEnabled: Boolean(codexBridge) }),
  onShutdown: (reason) => void shutdown(reason),
});

console.log("[linkfei] 正在连接飞书长连接……");
try {
  await channel.connect();
  codexBridge?.start();
  notificationService.start();
  runtimeState.state = "connected";
  console.log("[linkfei] 已连接，等待消息。", {
    database: config.storage.databasePath,
    controlPort: runtimeControl.runtime.port,
  });
} catch (error) {
  await runtimeControl.close().catch(() => {});
  storage.close();
  throw error;
}
