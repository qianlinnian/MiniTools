// Explicit opt-in smoke test: a tiny real Codex turn; no Feishu messages.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CodexBridge } from "../src/codex/bridge.mjs";
import { createSqliteStore } from "../src/storage/sqlite-store.mjs";
if (!process.argv.includes("--run")) throw new Error("Use --run to authorize one real Codex test turn.");
const cwd = resolve("data/codex-smoke"); mkdirSync(cwd, { recursive: true });
const storage = createSqliteStore({ databasePath: ":memory:" });
const bridge = new CodexBridge({ storage, config: { enabled: true, ownerId: "test", chatId: "test", projects: { smoke: cwd } } });
try {
  console.log(await bridge.handle({ chatType: "p2p", senderId: "test", chatId: "test" }, "/codex new smoke | 这是消息通道验收。只回复 LINKFEI_CODEX_OK，不调用工具、不读写文件。"));
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const task = storage.db.prepare("SELECT * FROM codex_remote_tasks WHERE id=1").get();
    if (["completed", "failed", "unknown", "interrupted"].includes(task.status)) {
      console.log(JSON.stringify({ status: task.status, markerReceived: task.output.includes("LINKFEI_CODEX_OK"), queuedResults: storage.listNotifications().length }));
      if (task.status !== "completed") console.log(storage.listNotifications().map(job => job.body).join("\n"));
      if (task.status !== "completed" || !task.output.includes("LINKFEI_CODEX_OK")) process.exitCode = 1;
      break;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  const task = storage.db.prepare("SELECT * FROM codex_remote_tasks WHERE id=1").get();
  if (task?.status === "running") {
    await bridge.client.request("turn/interrupt", { threadId: task.thread_id, turnId: task.turn_id });
    console.log("Smoke test timed out; interrupted only its own test turn."); process.exitCode = 1;
  }
  if (task?.thread_id) await bridge.client.request("thread/archive", { threadId: task.thread_id });
} finally { bridge.close(); storage.close(); }
