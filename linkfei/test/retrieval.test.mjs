import assert from "node:assert/strict";
import test from "node:test";

import {
  cosineSimilarity,
  rankByRelevance,
  splitKnowledgeContent,
  tokenize,
} from "../src/retrieval.mjs";

test("tokenizes Chinese text into searchable bigrams", () => {
  assert.deepEqual(tokenize("飞书机器人 API"), ["api", "飞书", "书机", "机器", "器人"]);
});

test("ranks related knowledge above unrelated content", () => {
  const items = ["财务报销流程与发票要求", "飞书机器人权限申请流程"];
  const ranked = rankByRelevance(items, "飞书权限", { limit: 2 });
  assert.equal(ranked[0].item, items[1]);
  assert.equal(ranked.length, 1);
  assert.ok(cosineSimilarity("飞书权限", items[1]) > 0);
});

test("splits long knowledge content into bounded chunks", () => {
  const chunks = splitKnowledgeContent("第一段内容\n\n第二段内容很长", {
    maxChars: 8,
  });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 8));
});
