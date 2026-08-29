import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { queryRuntime, startRuntimeControl } from "../src/runtime-control.mjs";

test("本地运行态端点鉴权并报告健康状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linkfei-runtime-"));
  const runtimePath = join(directory, "runtime.json");
  const control = await startRuntimeControl({
    runtimePath,
    projectPath: directory,
    status: () => ({ state: "connected" }),
  });
  try {
    const stored = JSON.parse(await readFile(runtimePath, "utf8"));
    const health = await queryRuntime(stored);
    assert.equal(health.ok, true);
    assert.equal(health.state, "connected");
    const unauthorized = await fetch(`http://127.0.0.1:${stored.port}/health`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("健康的运行实例会阻止第二个实例启动", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linkfei-single-"));
  const runtimePath = join(directory, "runtime.json");
  const first = await startRuntimeControl({ runtimePath, projectPath: directory });
  try {
    await assert.rejects(
      startRuntimeControl({ runtimePath, projectPath: directory }),
      /已在运行/,
    );
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});
