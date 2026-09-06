import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand, SYSTEM_PROMPT } from "../src/conversation.mjs";

test("routes natural-language command questions to LinkFei help", () => {
  for (const input of [
    "你都有哪些指令？",
    "你支持什么命令",
    "指令列表",
    "你能做什么？",
    "我的意思是类似于 /doc 这样子的指令。",
  ]) {
    assert.deepEqual(parseCommand(input), { type: "help" }, input);
  }
});

test("identifies the assistant as LinkFei with real backend capabilities", () => {
  assert.match(SYSTEM_PROMPT, /你是 LinkFei/);
  assert.match(SYSTEM_PROMPT, /\/doc 创建飞书文档/);
  assert.match(SYSTEM_PROMPT, /不得否认/);
});

test("routes natural-language document creation without mistaking questions for actions", () => {
  const command = parseCommand(
    "帮我创建一份飞书文档，标题是项目周报，内容包括本周进展和风险",
  );
  assert.equal(command.type, "doc");
  assert.equal(command.title, "项目周报");
  assert.match(command.prompt, /本周进展和风险/);

  assert.deepEqual(parseCommand("把这些内容写到飞书里面"), {
    type: "guidance",
    message:
      "我可以直接创建飞书文档，但还需要文档标题。请例如发送：`创建飞书文档，标题是项目周报，内容包括本周进展和风险`。",
  });
  assert.deepEqual(parseCommand("怎么创建飞书文档？"), {
    type: "chat",
    tier: "flash",
    prompt: "怎么创建飞书文档？",
  });
});

test("routes natural-language actions across LinkFei capabilities", () => {
  assert.deepEqual(parseCommand("用 Pro 模型分析这个方案"), {
    type: "chat",
    tier: "pro",
    prompt: "这个方案",
  });
  assert.deepEqual(parseCommand("记住我喜欢简洁回答"), {
    type: "remember",
    content: "我喜欢简洁回答",
  });
  assert.deepEqual(parseCommand("查看我的长期记忆"), { type: "memory" });
  assert.deepEqual(parseCommand("在知识库中搜索发布风险"), {
    type: "knowledge",
    action: "search",
    value: "发布风险",
  });
  assert.deepEqual(parseCommand("把先灰度再全量加入知识库，标题是发布流程"), {
    type: "knowledge",
    action: "add",
    title: "发布流程",
    content: "先灰度再全量",
  });
  assert.deepEqual(parseCommand("查看最近文档任务"), { type: "tasks" });
  assert.deepEqual(parseCommand("给我发一条飞书通知测试"), {
    type: "notify",
    action: "test",
    value: "",
  });
  assert.deepEqual(parseCommand("暂停网页监控 3"), {
    type: "watch",
    action: "pause",
    value: "3",
  });
});

test("requires explicit slash commands for destructive natural-language requests", () => {
  assert.equal(parseCommand("删除长期记忆 3").type, "guidance");
  assert.equal(parseCommand("删除知识库条目 2").type, "guidance");
  assert.equal(parseCommand("删除网页监控 4").type, "guidance");
});

test("creates a natural-language webpage monitor with a deterministic default name", () => {
  assert.deepEqual(
    parseCommand("监控这个页面 https://status.example.com 每 30 分钟"),
    {
      type: "watch",
      action: "add",
      name: "status.example.com 页面",
      url: "https://status.example.com",
      interval: "30m",
      selector: "",
    },
  );
});

test("parses a document title with an inline requirement", () => {
  assert.deepEqual(parseCommand("/doc 项目周报 | 面向管理层，突出风险"), {
    type: "doc",
    title: "项目周报",
    prompt: "面向管理层，突出风险",
  });
});

test("uses following lines as the document requirement", () => {
  assert.deepEqual(parseCommand("/文档 发布方案\n包含时间表和回滚计划"), {
    type: "doc",
    title: "发布方案",
    prompt: "包含时间表和回滚计划",
  });
});

test("parses memory and knowledge commands", () => {
  assert.deepEqual(parseCommand("/remember 我喜欢简洁回答"), {
    type: "remember",
    content: "我喜欢简洁回答",
  });
  assert.deepEqual(parseCommand("/知识库 添加 发布流程 | 先灰度再全量"), {
    type: "knowledge",
    action: "add",
    title: "发布流程",
    content: "先灰度再全量",
  });
  assert.deepEqual(parseCommand("/kb search 发布风险"), {
    type: "knowledge",
    action: "search",
    value: "发布风险",
  });
});
