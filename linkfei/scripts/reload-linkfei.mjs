import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { queryRuntime } from "../src/runtime-control.mjs";
const runtimePath = resolve("data/linkfei-runtime.json");
const readRuntime = async () => {
  try { return JSON.parse(await readFile(runtimePath, "utf8")); } catch { return null; }
};
const runtime = await readRuntime();
const state = await queryRuntime(runtime);
if (!process.argv.includes("--reload")) {
  console.log(JSON.stringify({ running: Boolean(state?.ok), state: state?.state, codexRemoteEnabled: state?.codexRemoteEnabled === true }));
} else {
  if (!state?.ok || resolve(state.projectPath).toLowerCase() !== process.cwd().toLowerCase()) throw new Error("运行实例不匹配，未执行重载。");
  const db = new DatabaseSync(resolve(process.env.LINKFEI_DB_PATH || "data/linkfei.sqlite"), { readOnly: true });
  try {
    const messages = db.prepare("SELECT count(*) AS n FROM processed_events WHERE status='processing'").get().n;
    const docs = db.prepare("SELECT count(*) AS n FROM document_tasks WHERE status IN ('generating','writing')").get().n;
    const hasRemote = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_remote_tasks'").get();
    const remote = hasRemote ? db.prepare("SELECT count(*) AS n FROM codex_remote_tasks WHERE status IN ('running','starting','waiting')").get().n : 0;
    if (messages || docs || remote) throw new Error("当前有处理中任务，未执行重载。");
  } finally { db.close(); }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/shutdown`, {
    method: "POST", headers: { authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("服务拒绝重载请求。");
  console.log("已请求闲置 LinkFei 退出，等待现有控制器自动恢复。");
  let ready = false;
  for (let i = 0; i < 25; i++) {
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
    const next = await queryRuntime(await readRuntime());
    if (next?.pid !== runtime.pid && next?.state === "connected") {
      console.log(JSON.stringify({ connected: true, codexRemoteEnabled: next.codexRemoteEnabled === true })); ready = true; break;
    }
  }
  if (!ready) { console.log("控制器尚未恢复连接，请检查控制中心。"); process.exitCode = 1; }
}
