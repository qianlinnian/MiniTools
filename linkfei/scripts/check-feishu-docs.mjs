import assert from "node:assert/strict";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";

import { assertFeishuConfig, loadConfig } from "../src/config.mjs";
import {
  createFeishuDocument,
  deleteFeishuDocument,
  listFeishuDocumentBlocks,
  readFeishuDocument,
} from "../src/feishu-docs.mjs";

const shouldCreate = process.argv.includes("--create-test-document");
const shouldDelete = process.argv.includes("--delete-after-check");
if (!shouldCreate) {
  throw new Error(
    "该检查会在飞书中创建真实文档。确认后使用：node scripts/check-feishu-docs.mjs --create-test-document --delete-after-check",
  );
}
if (!shouldDelete) {
  throw new Error(
    "为避免遗留测试文档，本验收必须同时提供 --delete-after-check。",
  );
}

const config = loadConfig();
assertFeishuConfig(config);
const silentSdkLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};
const client = new Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  loggerLevel: LoggerLevel.error,
  logger: silentSdkLogger,
});
const marker = `LF-FEISHU-STYLE-E2E-${Date.now()}`;
const title = `[LinkFei 样式验收] ${new Date().toLocaleString("zh-CN", {
  timeZone: "Asia/Shanghai",
})}`;
const content = [
  "# 一级标题：LinkFei Markdown 样式验收",
  "",
  "## 二级标题",
  "",
  `验证标识：${marker}`,
  "",
  "普通段落包含 **粗体**、*斜体*、~~删除线~~、`inlineCode()` 和 [飞书开放平台](https://open.feishu.cn/)。",
  "",
  "- 无序列表项目",
  "  - 嵌套无序列表项目",
  "",
  "1. 有序列表第一项",
  "2. 有序列表第二项",
  "",
  "> 这是一段引用，用于验证原生引用块。",
  "",
  "```javascript",
  "const square = (value) => value ** 2;",
  "console.log(square(6));",
  "```",
  "",
  "| 功能 | 状态 |",
  "| --- | --- |",
  "| 代码块 | 待验收 |",
  "| 公式 | 待验收 |",
  "",
  "---",
  "",
  "行内公式：$E=mc^2$",
  "",
  "$$\\frac{a+b}{c}$$",
].join("\n");

function elementsOf(block) {
  return Object.values(block || {})
    .filter((value) =>
      value && typeof value === "object" && Array.isArray(value.elements),
    )
    .flatMap((value) => value.elements);
}

function kindsOf(block) {
  const metadata = new Set([
    "block_id",
    "block_type",
    "parent_id",
    "children",
    "comment_ids",
  ]);
  return Object.entries(block || {})
    .filter(([key, value]) =>
      !metadata.has(key) && value && typeof value === "object" && !Array.isArray(value),
    )
    .map(([key]) => key);
}

async function verifyDeleted(documentId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await readFeishuDocument({
        client,
        documentId,
        docBaseUrl: config.feishu.docBaseUrl,
      });
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

let document;
let verification;
try {
  document = await createFeishuDocument({
    client,
    title,
    content,
    docBaseUrl: config.feishu.docBaseUrl,
  });

  const readBack = await readFeishuDocument({
    client,
    documentId: document.documentId,
    docBaseUrl: config.feishu.docBaseUrl,
  });
  assert.match(readBack.content, new RegExp(marker));

  const rawResponse = await client.docx.v1.documentBlock.list({
    params: { page_size: 500 },
    path: { document_id: document.documentId },
  });
  assert.equal(rawResponse.code ?? 0, 0, rawResponse.msg || "读取文档块失败");
  const rawBlocks = rawResponse.data?.items || [];
  const blockKinds = new Set(rawBlocks.flatMap(kindsOf));
  const elements = rawBlocks.flatMap(elementsOf);
  const equationContents = elements
    .map((element) => element?.equation?.content)
    .filter(Boolean);
  const textRuns = elements.map((element) => element?.text_run).filter(Boolean);
  const styles = textRuns.map((run) => run.text_element_style || {});

  for (const expected of [
    "heading1",
    "heading2",
    "bullet",
    "ordered",
    "quote",
    "code",
    "table",
    "divider",
  ]) {
    assert.ok(blockKinds.has(expected), `未找到原生 ${expected} 文档块`);
  }
  assert.ok(styles.some((style) => style.bold), "未找到粗体样式");
  assert.ok(styles.some((style) => style.italic), "未找到斜体样式");
  assert.ok(styles.some((style) => style.strikethrough), "未找到删除线样式");
  assert.ok(styles.some((style) => style.inline_code), "未找到行内代码样式");
  assert.ok(styles.some((style) => style.link?.url), "未找到链接样式");
  assert.ok(equationContents.length >= 2, "未找到行内和块级公式元素");
  assert.ok(equationContents.some((value) => value.includes("E=mc^2")));
  assert.ok(equationContents.some((value) => value.includes("frac")));

  const normalizedBlocks = await listFeishuDocumentBlocks({
    client,
    documentId: document.documentId,
  });
  verification = {
    marker,
    title: document.title,
    url: document.url,
    rawBlockCount: rawBlocks.length,
    normalizedBlockCount: normalizedBlocks.length,
    blockKinds: [...blockKinds].sort(),
    equationCount: equationContents.length,
    styles: {
      bold: true,
      italic: true,
      strikethrough: true,
      inlineCode: true,
      link: true,
    },
  };
  console.log(JSON.stringify({ ok: true, phase: "verified", verification }, null, 2));
} finally {
  if (document && shouldDelete) {
    const deletion = await deleteFeishuDocument({
      client,
      documentId: document.documentId,
      docBaseUrl: config.feishu.docBaseUrl,
    });
    const inaccessible = await verifyDeleted(document.documentId);
    assert.equal(inaccessible, true, "删除后文档仍可读取，无法确认已进入回收站");
    console.log(JSON.stringify({
      ok: true,
      phase: "deleted",
      deletion: {
        documentId: deletion.documentId,
        deleted: deletion.deleted,
        inaccessible,
      },
    }, null, 2));
  }
}
