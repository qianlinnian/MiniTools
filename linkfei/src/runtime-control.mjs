import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

function json(response, statusCode, body) {
  const content = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
  });
  response.end(content);
}

async function readRuntime(runtimePath) {
  try {
    return JSON.parse(await readFile(runtimePath, "utf8"));
  } catch {
    return null;
  }
}

export async function queryRuntime(runtime, { timeoutMs = 1_500 } = {}) {
  if (!runtime?.port || !runtime?.token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, {
      headers: { authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function startRuntimeControl({
  runtimePath = "data/linkfei-runtime.json",
  projectPath = process.cwd(),
  status = () => ({}),
  onShutdown = () => {},
} = {}) {
  const resolvedRuntimePath = resolve(runtimePath);
  const existing = await readRuntime(resolvedRuntimePath);
  const existingHealth = await queryRuntime(existing);
  if (existingHealth?.ok) {
    throw new Error(`LinkFei 已在运行（PID ${existingHealth.pid}）。`);
  }

  const token = randomBytes(32).toString("hex");
  const startedAt = new Date().toISOString();
  let shutdownRequested = false;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, {
        ok: true,
        pid: process.pid,
        startedAt,
        projectPath: resolve(projectPath),
        ...status(),
      });
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      if (!shutdownRequested) {
        shutdownRequested = true;
        setTimeout(() => onShutdown("托盘控制"), 25);
      }
      json(response, 202, { ok: true, shuttingDown: true });
      return;
    }
    json(response, 404, { ok: false, error: "not_found" });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const runtime = {
    version: 1,
    pid: process.pid,
    port: address.port,
    token,
    startedAt,
    projectPath: resolve(projectPath),
  };
  await mkdir(dirname(resolvedRuntimePath), { recursive: true });
  await writeFile(resolvedRuntimePath, JSON.stringify(runtime, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  async function close() {
    await new Promise((resolveClose) => server.close(resolveClose));
    const current = await readRuntime(resolvedRuntimePath);
    if (current?.token === token) {
      await unlink(resolvedRuntimePath).catch(() => {});
    }
  }

  return { runtime, close };
}
