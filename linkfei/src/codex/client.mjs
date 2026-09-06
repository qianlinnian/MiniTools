import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export function resolveCodexCommand() {
  if (process.env.LINKFEI_CODEX_EXECUTABLE) return { file: process.env.LINKFEI_CODEX_EXECUTABLE, args: [] };
  const native = join(process.env.APPDATA || "", "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
  if (process.platform === "win32" && existsSync(native)) return { file: native, args: [] };
  const script = join(process.env.APPDATA || "", "npm/node_modules/@openai/codex/bin/codex.js");
  if (process.platform === "win32" && existsSync(script)) return { file: process.execPath, args: [script] };
  return { file: "codex", args: [] };
}

export class CodexClient extends EventEmitter {
  constructor({ command = resolveCodexCommand(), spawnImpl = spawn, timeoutMs = 30000 } = {}) {
    super(); Object.assign(this, { command, spawnImpl, timeoutMs });
    this.pending = new Map(); this.nextId = 0;
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.connect().catch(error => { this.close(); throw error; });
    return this.ready;
  }
  async connect() {
    const child = this.spawnImpl(this.command.file, [...this.command.args, "app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    this.child = child;
    // Never log raw protocol payloads or stderr: they may contain credentials.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.disconnected(child));
    child.once("error", () => this.disconnected(child));
    child.once("exit", () => this.disconnected(child));
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method) this.emit("message", message);
      else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`Codex 请求失败（${message.error.code ?? "unknown"}）；请检查本机登录、模型和配置。`));
        else pending.resolve(message.result);
      }
    });
    await this.request("initialize", { clientInfo: { name: "linkfei_remote", version: "0.1.0" } });
    this.write({ method: "initialized" });
  }
  write(message) {
    if (!this.child?.stdin.writable) throw new Error("Codex 连接已断开。");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error("Codex 请求超时，执行结果未知；请先查询状态，不要重复提交。"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id, result) { this.write({ id, result }); }
  disconnected(child) {
    if (child !== this.child) return;
    this.child = null; this.ready = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex 本地连接已断开。")); }
    this.pending.clear(); this.emit("disconnect");
  }
  close() {
    const child = this.child;
    this.lines?.close();
    child?.stdin.end(); child?.kill();
    this.disconnected(child);
  }
}
