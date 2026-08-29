import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "../src/conversation.mjs";

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
