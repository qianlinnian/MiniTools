import { fetchPageSnapshot } from "./page-fetcher.mjs";

const LEVEL_ICONS = {
  info: "🔔",
  success: "✅",
  warning: "⚠️",
  error: "❌",
};

export function describePageChange(previous, current) {
  const before = String(previous || "");
  const after = String(current || "");
  if (before === after) return "页面其他区域发生变化，前 1200 字摘要未变化。";
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  return `摘要差异（仅比较前 1200 字）：\n移除：${removed.slice(0, 500) || "（无）"}\n新增：${added.slice(0, 500) || "（无）"}`;
}

function nextIso(delayMs) {
  return new Date(Date.now() + delayMs).toISOString();
}

function renderNotification(job) {
  const icon = LEVEL_ICONS[job.level] || LEVEL_ICONS.info;
  const lines = [`${icon} **${job.title}**`, "", job.body || "（无详细内容）"];
  if (job.url) lines.push("", `[查看页面](${job.url})`);
  lines.push("", `发送时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  return lines.join("\n");
}

export function createNotificationService({
  storage,
  send,
  logger = console,
  tickMs = 15_000,
  failureThreshold = 3,
  maxSendAttempts = 8,
  fetchOptions = {},
} = {}) {
  if (!storage || typeof send !== "function") {
    throw new Error("通知服务需要 storage 和 send。");
  }
  let timer = null;
  let running = false;

  async function drainOutbox(limit = 10) {
    for (let count = 0; count < limit; count += 1) {
      const job = storage.claimDueNotification();
      if (!job) return;
      try {
        await send(job.chat_id, renderNotification(job));
        storage.completeNotification(job.id);
        logger.info?.(`[notify] 已发送 #${job.id}: ${job.title}`);
      } catch (error) {
        const dead = job.attempts >= maxSendAttempts;
        const delayMs = Math.min(60 * 60_000, 15_000 * 2 ** Math.max(0, job.attempts - 1));
        storage.retryNotification(job.id, error?.message || error, {
          dead,
          nextAttemptAt: nextIso(delayMs),
        });
        logger.error?.(`[notify] 发送 #${job.id} 失败：${error?.message || error}`);
      }
    }
  }

  async function checkMonitor(monitor) {
    const nextCheckAt = nextIso(monitor.interval_seconds * 1_000);
    try {
      const snapshot = await fetchPageSnapshot(monitor.url, {
        selector: monitor.selector,
        ...fetchOptions,
      });
      const firstCheck = !monitor.last_hash;
      const changed = !firstCheck && monitor.last_hash !== snapshot.hash;
      storage.completePageMonitorCheck(monitor.id, {
        hash: snapshot.hash,
        excerpt: snapshot.excerpt,
        nextCheckAt,
      });
      if (changed) {
        storage.enqueueNotification({
          title: `页面已更新：${monitor.name}`,
          body: `${describePageChange(monitor.last_excerpt, snapshot.excerpt)}\n\n当前内容摘要：\n${snapshot.excerpt}`,
          url: snapshot.finalUrl,
          level: "success",
          idempotencyKey: `monitor:${monitor.id}:change:${snapshot.hash}`,
        });
      }
      logger.info?.(
        `[monitor] #${monitor.id} ${firstCheck ? "已建立基线" : changed ? "检测到变化" : "无变化"}`,
      );
    } catch (error) {
      const updated = storage.failPageMonitorCheck(monitor.id, {
        error: error?.message || error,
        nextCheckAt,
      });
      if (
        updated.consecutive_failures >= failureThreshold &&
        !updated.error_notified
      ) {
        storage.enqueueNotification({
          title: `页面监控连续失败：${monitor.name}`,
          body: `已连续失败 ${updated.consecutive_failures} 次。\n\n原因：${updated.last_error}`,
          url: monitor.url,
          level: "error",
          idempotencyKey: `monitor:${monitor.id}:failure:${updated.last_hash || "initial"}`,
        });
        storage.markPageMonitorErrorNotified(monitor.id);
      }
      logger.error?.(`[monitor] #${monitor.id} 检查失败：${error?.message || error}`);
    }
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      await drainOutbox();
      const monitor = storage.claimDuePageMonitor();
      if (monitor) await checkMonitor(monitor);
      await drainOutbox();
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    storage.recoverNotificationJobs();
    storage.recoverPageMonitorJobs();
    timer = setInterval(() => {
      runOnce().catch((error) => logger.error?.(`[monitor] 调度失败：${error?.message || error}`));
    }, tickMs);
    runOnce().catch((error) => logger.error?.(`[monitor] 启动检查失败：${error?.message || error}`));
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function enqueue(notification) {
    const result = storage.enqueueNotification(notification);
    setTimeout(() => {
      runOnce().catch((error) => logger.error?.(`[notify] 即时发送失败：${error?.message || error}`));
    }, 0);
    return result;
  }

  return { start, stop, runOnce, enqueue };
}
