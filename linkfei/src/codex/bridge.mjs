import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { CodexClient } from "./client.mjs";

export const CODEX_HELP = [
  "Codex 远程控制（仅限已授权私聊）：",
  "`/codex projects`：项目列表",
  "`/codex new 项目名 | 任务要求`：创建任务",
  "`/codex list`：最近任务",
  "`/codex status 编号`：状态与最近输出",
  "`/codex send 编号 | 补充要求`：继续或在运行中追加指令",
  "`/codex stop 编号`：停止该任务",
  "`/codex approve 确认码`、`/codex deny 确认码`：回应单次命令审批",
].join("\n");

export function redact(value) {
  let text = String(value ?? "");
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(secret|token|password|api.?key)/i.test(key) && secret?.length >= 8) text = text.split(secret).join("[已隐藏]");
  }
  return text.replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\/-]{12,})/gi, "[已隐藏]")
    .replace(/((?:password|passwd|api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/(-pw\s+)(?:'[^']*'|"[^"]*"|\S+)/gi, "$1[已隐藏]");
}

export class CodexBridge {
  constructor({ storage, config, client = new CodexClient() }) {
    Object.assign(this, { storage, config, client });
    this.db = storage.db; this.approvals = new Map(); this.loaded = new Set();
    this.chain = Promise.resolve(); this.closing = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_remote_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      project TEXT NOT NULL, cwd TEXT NOT NULL, thread_id TEXT UNIQUE, turn_id TEXT,
      status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    )`);
    try { this.db.exec("ALTER TABLE codex_remote_tasks ADD COLUMN last_synced_turn_id TEXT"); } catch { /* Existing databases already have it. */ }
    client.on("message", message => {
      try { this.onMessage(message); } catch { /* Raw protocol contents never reach logs. */ }
    });
    client.on("disconnect", () => {
      this.loaded.clear(); this.clearApprovals();
      if (!this.closing) this.recover("Codex 连接中断，任务结果未知，请查询状态后再继续。");
    });
  }
  start() {
    this.recover("LinkFei 已重启；先查询任务状态，再决定是否继续。");
    // A separate desktop client can continue the same persisted Codex thread.
    // Establish a quiet baseline first, then report only newly completed turns.
    void this.syncAll({ notify: false });
    this.syncTimer = setInterval(() => void this.syncAll({ notify: true }), 20_000);
    this.syncTimer.unref?.();
  }
  recover(body) {
    const tasks = this.db.prepare("SELECT * FROM codex_remote_tasks WHERE status IN ('starting','running','waiting')").all();
    for (const task of tasks) { this.update(task.id, { status: "unknown" }); this.notify(task, body, `recovery:${task.id}:${task.updated_at}`); }
  }
  update(id, values) {
    const allowed = ["thread_id", "turn_id", "status", "output", "last_synced_turn_id"];
    const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
    this.db.prepare(`UPDATE codex_remote_tasks SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value), new Date().toISOString(), id);
  }
  notify(task, body, key) {
    const safe = redact(body);
    for (let offset = 0; offset < safe.length; offset += 3000) {
      this.storage.enqueueNotification({ chatId: task.chat_id, title: `Codex #${task.id}`,
        body: safe.slice(offset, offset + 3000), idempotencyKey: `codex:${key}:${offset}` });
    }
  }
  async syncTask(task, { notify = false } = {}) {
    if (!task?.thread_id) return task;
    const result = await this.client.request("thread/read", { threadId: task.thread_id, includeTurns: true });
    const turns = [...(result.thread?.turns || [])].sort((left, right) =>
      (left.startedAt || left.completedAt || 0) - (right.startedAt || right.completedAt || 0));
    const last = turns.at(-1);
    if (!last) return task;
    const active = last.status === "inProgress" || result.thread?.status?.type === "active";
    const status = active ? "running" : last.status;
    const text = last.items?.filter(item => item.type === "agentMessage").map(item => redact(item.text)).filter(Boolean).join("\n");
    const terminal = ["completed", "failed", "interrupted"].includes(last.status);
    const freshCompletion = terminal && last.id !== task.last_synced_turn_id;
    this.update(task.id, {
      turn_id: last.id,
      status,
      ...(text ? { output: text.slice(-60000) } : {}),
      ...(terminal ? { last_synced_turn_id: last.id } : {}),
    });
    const updated = this.db.prepare("SELECT * FROM codex_remote_tasks WHERE id = ?").get(task.id);
    if (notify && freshCompletion) {
      this.notify(updated, `桌面端任务${this.statusName(last.status)}。\n${text || "暂无文字结果。"}`, `desktop-completed:${last.id}`);
    }
    return updated;
  }
  async syncAll({ notify = false } = {}) {
    if (this.syncing || this.closing) return;
    this.syncing = true;
    try {
      await this.client.start();
      const tasks = this.db.prepare("SELECT * FROM codex_remote_tasks WHERE thread_id IS NOT NULL ORDER BY id DESC LIMIT 30").all();
      for (const task of tasks) {
        try { await this.syncTask(task, { notify }); } catch { /* Keep last known state on a transient read failure. */ }
      }
    } finally { this.syncing = false; }
  }
  authorized(message) {
    return this.config?.enabled === true && message.chatType === "p2p"
      && Boolean(this.config.ownerId && this.config.chatId)
      && message.senderId === this.config.ownerId && message.chatId === this.config.chatId;
  }
  async handle(message, text) {
    if (!this.authorized(message)) return "Codex 远程控制未启用，或当前私聊没有控制权限；需在电脑上配置授权。";
    const command = text.replace(/^\/codex(?:\s+|$)/i, "").trim();
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command);
    const action = (match?.[1] || "help").toLowerCase(), body = match?.[2]?.trim() || "";
    if (action === "help") return CODEX_HELP;
    if (action === "projects") return Object.keys(this.config.projects || {}).map(key => `- ${key}`).join("\n") || "暂无授权项目。";
    if (action === "list") {
      const tasks = this.db.prepare("SELECT * FROM codex_remote_tasks WHERE owner_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 10")
        .all(message.senderId, message.chatId);
      return tasks.map(task => `#${task.id} · ${task.project} · ${this.statusName(task.status)}`).join("\n") || "暂无远程任务。";
    }
    // Serialize submissions, never the whole model turn. Stop/status remain responsive during generation.
    const result = this.chain.then(() => this.execute(message, action, body));
    this.chain = result.catch(() => {});
    return result;
  }
  statusName(status) {
    return ({ starting: "正在提交", running: "执行中", waiting: "等待确认", completed: "已完成",
      interrupted: "已停止", failed: "失败", unknown: "状态待核验" })[status] || status;
  }
  async execute(message, action, body) {
    if (["approve", "deny"].includes(action)) {
      const pending = this.approvals.get(body);
      if (!pending) return "确认码无效或已过期。";
      this.approvals.delete(body); clearTimeout(pending.timer);
      this.client.respond(pending.id, { decision: action === "approve" ? "accept" : "decline" });
      this.update(pending.task.id, { status: "running" });
      return action === "approve" ? "已批准这一次命令。" : "已拒绝这一次命令。";
    }
    if (!["new", "send", "status", "stop"].includes(action)) return CODEX_HELP;
    const parts = body.split(/\s*\|\s*/), target = parts.shift()?.trim(), prompt = parts.join(" | ").trim();
    if (["new", "send"].includes(action) && (!prompt || prompt.length > 20000)) return "用法：`/codex new 项目名 | 要求` 或 `/codex send 编号 | 要求`（最多 20000 字）。";
    let task;
    if (action === "new") {
      if (!Object.hasOwn(this.config.projects || {}, target)) return "项目未授权，请用 `/codex projects` 查看。";
      const busy = this.db.prepare("SELECT id FROM codex_remote_tasks WHERE status IN ('starting','running','waiting','unknown')").get();
      if (busy) return `已有未结束任务 #${busy.id}，请先查询或停止；当前远程入口一次执行一个任务。`;
      const cwd = realpathSync(this.config.projects[target]);
      const result = this.db.prepare("INSERT INTO codex_remote_tasks(owner_id,chat_id,project,cwd,status,updated_at) VALUES(?,?,?,?,'starting',?)")
        .run(message.senderId, message.chatId, target, cwd, new Date().toISOString());
      task = this.db.prepare("SELECT * FROM codex_remote_tasks WHERE id = ?").get(Number(result.lastInsertRowid));
    } else {
      if (!/^\d+$/.test(target || "")) return "请输入任务编号，例如 `/codex status 1`。";
      task = this.db.prepare("SELECT * FROM codex_remote_tasks WHERE id = ? AND owner_id = ? AND chat_id = ?")
        .get(Number(target), message.senderId, message.chatId);
      if (!task) return "没有找到当前私聊的任务。";
      if (action === "send" && !["running", "waiting", "unknown"].includes(task.status)) {
        const other = this.db.prepare("SELECT id FROM codex_remote_tasks WHERE id != ? AND status IN ('starting','running','waiting','unknown')").get(task.id);
        if (other) return `已有未结束任务 #${other.id}，请先查询或停止；当前远程入口一次执行一个任务。`;
      }
      if (action === "status") {
        try { await this.client.start(); task = await this.syncTask(task); } catch { /* Preserve last known state when the local reader is unavailable. */ }
        return `#${task.id} · ${this.statusName(task.status)}\n项目：${task.project}\n更新时间：${task.updated_at}\n${redact(task.output).slice(-5000) || "暂无输出。"}`;
      }
    }
    try {
      await this.client.start();
      if (!task.thread_id) {
        if (action !== "new") return "原任务未取得 Codex 会话编号，不能自动重放请求。请在电脑核验后处理。";
        const catalog = await this.client.request("model/list", {});
        const selected = this.config.model || catalog.data?.find(model => model.isDefault)?.model;
        if (!selected || !catalog.data?.some(model => model.model === selected)) throw new Error("配置的模型不在本机 Codex 可用列表中，请在电脑检查配置。");
        const result = await this.client.request("thread/start", {
          cwd: task.cwd, model: selected,
          approvalPolicy: "on-request", sandbox: "workspace-write",
          developerInstructions: "你通过飞书接受此用户的指令。用简洁中文汇报进度和结果。不要在输出、日志或命令参数中泄露凭据。保留工作区 AGENTS.md 规则，无法完成审批时明确报告。不要声称消息已送达，除非工具确认。",
        });
        this.update(task.id, { thread_id: result.thread.id }); task.thread_id = result.thread.id;
        this.loaded.add(task.thread_id);
      } else if (!this.loaded.has(task.thread_id)) {
        await this.client.request("thread/resume", { threadId: task.thread_id, cwd: task.cwd,
          approvalPolicy: "on-request", sandbox: "workspace-write" });
        this.loaded.add(task.thread_id);
      }
      if (action === "stop") {
        if (!task.turn_id || !["starting", "running", "waiting", "unknown"].includes(task.status)) return "该任务当前没有可停止的执行。";
        await this.client.request("turn/interrupt", { threadId: task.thread_id, turnId: task.turn_id });
        return `已请求停止 #${task.id}，确认停止后会另行通知。`;
      }
      if (task.status === "unknown") return "原任务状态不确定，暂不自动重新执行；请在电脑核验原会话，避免重复操作。";
      if (["running", "waiting"].includes(task.status)) {
        if (task.status === "waiting") return "任务正在等待审批，请先回应确认码。";
        await this.client.request("turn/steer", { threadId: task.thread_id, expectedTurnId: task.turn_id, input: [{ type: "text", text: prompt }] });
        return `补充要求已交给 #${task.id}。`;
      }
      this.update(task.id, { status: "starting", output: "", turn_id: null });
      const result = await this.client.request("turn/start", { threadId: task.thread_id, input: [{ type: "text", text: prompt }] });
      const fresh = this.db.prepare("SELECT * FROM codex_remote_tasks WHERE id = ?").get(task.id);
      if (fresh.status === "starting") this.update(task.id, { status: "running", turn_id: result.turn.id });
      return `已提交 Codex #${task.id}（${task.project}）。用 /codex status ${task.id} 查询，结果会自动发回。`;
    } catch (error) {
      if (action === "new" || action === "send") this.update(task.id, { status: task.thread_id ? "unknown" : "failed" });
      return `#${task.id}：${redact(error.message)} 用 /codex status ${task.id} 查看；不会自动重复执行。`;
    }
  }
  onMessage(message) {
    const p = message.params || {};
    const task = p.threadId ? this.db.prepare("SELECT * FROM codex_remote_tasks WHERE thread_id = ?").get(p.threadId) : null;
    if (message.id !== undefined) {
      if (task && message.method === "item/commandExecution/requestApproval" && p.command
          && p.command.length < 6000 && redact(p.command) === p.command) {
        const code = randomBytes(6).toString("hex");
        const timer = setTimeout(() => {
          const pending = this.approvals.get(code); if (!pending) return;
          this.approvals.delete(code);
          try { this.client.respond(message.id, { decision: "decline" }); this.update(task.id, { status: "running" });
            this.notify(task, "命令确认已过期，本次命令已拒绝。", `expired:${code}`); } catch {}
        }, 10 * 60000);
        timer.unref?.();
        this.approvals.set(code, { id: message.id, task, timer });
        this.update(task.id, { status: "waiting" });
        this.notify(task, `需要批准一次命令（10 分钟有效）：\n工作目录：${p.cwd || task.cwd}\n原因：${p.reason || "需要额外权限"}\n\n${p.command}\n\n/codex approve ${code}\n/codex deny ${code}`, `approval:${code}`);
      } else {
        if (/requestApproval$/.test(message.method) && !/permissions/i.test(message.method)) this.client.respond(message.id, { decision: "decline" });
        else this.client.write({ id: message.id, error: { code: -32601, message: "This remote client cannot present this request safely." } });
        if (task) this.notify(task, "Codex 请求了当前飞书入口尚不支持的交互或审批，本次请求未获批准。可补充普通文字指令，或在电脑处理。", `unsupported:${task.id}:${message.id}`);
      }
      return;
    }
    if (!task) return;
    if (message.method === "turn/started") this.update(task.id, { turn_id: p.turn.id, status: "running" });
    if (message.method === "item/completed" && p.item?.type === "agentMessage") {
      const output = `${task.output}\n${redact(p.item.text)}`.trim().slice(-60000);
      this.update(task.id, { output });
    }
    if (message.method === "turn/completed") {
      this.clearApprovals(task.id);
      const failure = p.turn.error ? `\n${redact(p.turn.error.message || "执行失败；请在电脑检查 Codex 状态。").slice(0, 1500)}` : "";
      const body = `任务${this.statusName(p.turn.status)}。\n${task.output || "暂无文字结果。"}${failure}`;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.update(task.id, { status: p.turn.status, last_synced_turn_id: p.turn.id });
        this.notify(task, body, `completed:${p.turn.id}`);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }
  clearApprovals(taskId) {
    for (const [code, pending] of this.approvals) if (!taskId || pending.task.id === taskId) {
      clearTimeout(pending.timer); this.approvals.delete(code);
    }
  }
  close() {
    this.closing = true; this.clearApprovals();
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null; this.client.close();
  }
}
