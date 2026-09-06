import { readFileSync } from "node:fs";

import { loadConfig } from "../src/config.mjs";
import { formatInterval, parseInterval } from "../src/monitoring/interval.mjs";
import { validateMonitorUrl } from "../src/monitoring/page-fetcher.mjs";
import { createSqliteStore } from "../src/storage/sqlite-store.mjs";

function parseArgs(argv) {
  const [command = "help", ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = tokens[index + 1]?.startsWith("--") ? true : tokens[++index] ?? true;
    options[key] = value;
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`缺少 --${key}。`);
  return String(value);
}

function monitorId(options) {
  const id = Number.parseInt(requireOption(options, "id"), 10);
  if (!Number.isInteger(id)) throw new Error("--id 必须是整数。");
  return id;
}

const HELP = `LinkFei 飞书主动消息 CLI

主动发送飞书消息（适用于任务结果、提醒、异常和其他后台事件）：
  npm run notify -- send --title "标题" --body "正文" [--url "https://..."] [--level info]
  npm run notify -- send --title "标题" --body-file "D:\\path\\body.md"
  npm run notify -- status

可选的网页变化触发器：
  npm run notify -- watch-add --name "页面名" --url "https://..." --interval 30m [--selector "main"]
  npm run notify -- watch-list
  npm run notify -- watch-check|watch-pause|watch-resume|watch-delete --id 1`;

const { command, options } = parseArgs(process.argv.slice(2));
if (command === "help" || options.help) {
  console.log(HELP);
  process.exit(0);
}

const config = loadConfig();
const storage = createSqliteStore({ databasePath: config.storage.databasePath });
try {
  if (command === "send") {
    const title = requireOption(options, "title");
    const body = options["body-file"]
      ? readFileSync(String(options["body-file"]), "utf8")
      : requireOption(options, "body");
    const result = storage.enqueueNotification({
      title,
      body,
      url: options.url ? String(options.url) : null,
      level: options.level ? String(options.level) : "info",
      idempotencyKey: options.key ? String(options.key) : null,
    });
    console.log(result.queued ? `通知已入队 #${result.id}。` : `相同通知已存在 #${result.id}（${result.status}）。`);
  } else if (command === "status") {
    const recipient = storage.getDefaultNotificationRecipient();
    console.log(recipient ? `默认飞书收件人已绑定：${recipient.label}` : "尚未绑定默认飞书收件人。");
    for (const item of storage.listNotifications({ limit: 20 })) {
      console.log(`#${item.id} ${item.status} 尝试 ${item.attempts} 次｜${item.title}`);
    }
  } else if (command === "watch-add") {
    if (!storage.getDefaultNotificationRecipient()) throw new Error("请先私聊机器人发送 /notify bind。");
    const intervalSeconds = parseInterval(requireOption(options, "interval"));
    if (!intervalSeconds) throw new Error("监控间隔无效（示例：30m、2h、1d；最短 1 分钟）。");
    const url = await validateMonitorUrl(requireOption(options, "url"));
    const monitor = storage.createPageMonitor({
      name: requireOption(options, "name").slice(0, 100),
      url: url.href,
      selector: options.selector ? String(options.selector) : null,
      intervalSeconds,
    });
    console.log(`已创建监控 #${monitor.id}，每 ${formatInterval(intervalSeconds)}检查一次。`);
  } else if (command === "watch-list") {
    const monitors = storage.listPageMonitors();
    if (!monitors.length) console.log("目前没有页面监控。");
    for (const item of monitors) {
      console.log(`#${item.id} ${item.state}｜${item.name}｜每 ${formatInterval(item.interval_seconds)}｜${item.url}`);
    }
  } else if (["watch-check", "watch-pause", "watch-resume", "watch-delete"].includes(command)) {
    const id = monitorId(options);
    let changed = false;
    if (command === "watch-check") changed = storage.schedulePageMonitorNow(id);
    if (command === "watch-pause") changed = storage.setPageMonitorState(id, "paused");
    if (command === "watch-resume") changed = storage.setPageMonitorState(id, "active");
    if (command === "watch-delete") changed = storage.deletePageMonitor(id) === 1;
    if (!changed) throw new Error(`没有找到监控 #${id}。`);
    console.log(`已执行 ${command}：#${id}。`);
  } else {
    throw new Error(`未知命令：${command}\n\n${HELP}`);
  }
} finally {
  storage.close();
}
