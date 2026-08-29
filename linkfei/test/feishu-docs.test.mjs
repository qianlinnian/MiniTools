import assert from "node:assert/strict";
import test from "node:test";

import {
  appendFeishuDocument,
  contentToTextBlocks,
  convertMarkdownToFeishuBlocks,
  createFeishuDocument,
  deleteFeishuDocument,
  formatFeishuError,
  getFeishuErrorDetails,
  listFeishuDocumentBlocks,
  normalizeFeishuDocumentId,
  readFeishuDocument,
  renameFeishuDocument,
  replaceFeishuDocumentContent,
  updateFeishuDocumentBlock,
} from "../src/feishu-docs.mjs";

test("converts paragraphs into Feishu text blocks", () => {
  const blocks = contentToTextBlocks("第一段\n\n第二段");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].block_type, 2);
  assert.equal(blocks[1].text.elements[0].text_run.content, "第二段");
});

test("creates a document and appends its body", async () => {
  const calls = [];
  const client = {
    docx: {
      v1: {
        document: {
          convert: async (payload) => {
            calls.push(["document.convert", payload]);
            return {
              code: 0,
              data: {
                first_level_block_ids: ["tmp-1"],
                blocks: [{
                  block_id: "tmp-1",
                  parent_id: "tmp-root",
                  block_type: 2,
                  text: { elements: [{ text_run: { content: "正文" } }] },
                }],
              },
            };
          },
          create: async (payload) => {
            calls.push(["document.create", payload]);
            return {
              code: 0,
              data: { document: { document_id: "doc-token" } },
            };
          },
        },
        documentBlockDescendant: {
          create: async (payload) => {
            calls.push(["descendant.create", payload]);
            return { code: 0 };
          },
        },
      },
    },
  };

  const result = await createFeishuDocument({
    client,
    title: "测试文档",
    content: "正文",
  });

  assert.equal(result.url, "https://feishu.cn/docx/doc-token");
  assert.deepEqual(calls.map(([name]) => name), [
    "document.convert",
    "document.create",
    "descendant.create",
  ]);
  assert.equal(calls[0][1].data.content_type, "markdown");
  assert.equal(calls[1][1].data.title, "测试文档");
  assert.equal(calls[2][1].path.block_id, "doc-token");
  assert.deepEqual(calls[2][1].data.children_id, ["tmp-1"]);
  assert.equal(calls[2][1].data.descendants[0].parent_id, undefined);
});

test("converts Markdown before creating a document", async () => {
  const client = {
    docx: {
      v1: {
        document: {
          convert: async (payload) => ({
            code: 0,
            data: {
              first_level_block_ids: ["heading", "formula"],
              blocks: [
                {
                  block_id: "heading",
                  parent_id: "temporary-root",
                  block_type: 3,
                  heading1: { elements: [{ text_run: { content: "标题" } }] },
                },
                {
                  block_id: "formula",
                  parent_id: "temporary-root",
                  block_type: 2,
                  text: { elements: [{ equation: { content: "E=mc^2" } }] },
                },
              ],
            },
          }),
        },
      },
    },
  };

  const converted = await convertMarkdownToFeishuBlocks({
    client,
    content: "# 标题\n\n$$E=mc^2$$",
  });
  assert.deepEqual(converted.childrenIds, ["heading", "formula"]);
  assert.equal(converted.descendants[0].parent_id, undefined);
  assert.equal(
    converted.descendants[1].text.elements[0].equation.content,
    "E=mc^2",
  );
});

test("removes read-only table merge info from converted blocks", async () => {
  const client = {
    docx: {
      v1: {
        document: {
          convert: async () => ({
            code: 0,
            data: {
              first_level_block_ids: ["table-1"],
              blocks: [{
                block_id: "table-1",
                parent_id: "temporary-root",
                block_type: 31,
                table: {
                  cells: ["cell-1"],
                  property: {
                    row_size: 1,
                    column_size: 1,
                    merge_info: [{ row_span: 1, col_span: 1 }],
                  },
                },
                children: ["cell-1"],
              }],
            },
          }),
        },
      },
    },
  };

  const converted = await convertMarkdownToFeishuBlocks({
    client,
    content: "| 表头 |\n| --- |\n| 内容 |",
  });
  assert.equal(converted.descendants[0].parent_id, undefined);
  assert.equal(converted.descendants[0].table.property.merge_info, undefined);
  assert.equal(converted.descendants[0].table.property.row_size, 1);
});

test("formats missing document permission as an actionable message", () => {
  const error = {
    response: {
      status: 400,
      headers: { "x-tt-logid": "log-123" },
      data: {
        code: 99991672,
        msg: "Access denied",
      },
    },
  };

  assert.deepEqual(getFeishuErrorDetails(error), {
    code: 99991672,
    message: "Access denied",
    logId: "log-123",
    status: 400,
  });
  assert.match(formatFeishuError(error, "创建飞书文档"), /创建及编辑新版文档/);
  assert.match(formatFeishuError(error, "创建飞书文档"), /管理员审批/);
});

test("formats missing Markdown conversion permission precisely", () => {
  const error = {
    response: {
      status: 400,
      data: {
        code: 99991672,
        msg: "Access denied: docx:document.block:convert",
      },
    },
  };

  assert.match(
    formatFeishuError(error, "转换 Markdown"),
    /docx:document\.block:convert/,
  );
  assert.doesNotMatch(formatFeishuError(error, "转换 Markdown"), /管理员审批/);
});

test("formats missing document deletion permission precisely", () => {
  const error = {
    response: {
      status: 400,
      data: {
        code: 99991672,
        msg: "Access denied: space:document:delete",
      },
    },
  };

  assert.match(
    formatFeishuError(error, "删除飞书文档"),
    /space:document:delete/,
  );
});

test("wraps Feishu API errors without exposing the raw request", async () => {
  const rawError = {
    message: "Request failed with status code 400",
    response: {
      status: 400,
      data: {
        code: 99991672,
        msg: "Access denied",
      },
    },
  };
  const client = {
    docx: {
      v1: {
        document: {
          convert: async () => {
            throw rawError;
          },
        },
      },
    },
  };

  await assert.rejects(
    createFeishuDocument({
      client,
      title: "测试文档",
      content: "正文",
    }),
    (error) => {
      assert.match(error.message, /应用缺少/);
      assert.equal(error.feishu.code, 99991672);
      assert.equal(error.cause, rawError);
      return true;
    },
  );
});

test("normalizes a docx URL or raw document id", () => {
  assert.equal(
    normalizeFeishuDocumentId("https://example.feishu.cn/docx/doxcn1234567890?from=from_copylink"),
    "doxcn1234567890",
  );
  assert.equal(normalizeFeishuDocumentId("doxcn1234567890"), "doxcn1234567890");
  assert.throws(() => normalizeFeishuDocumentId("https://example.feishu.cn/wiki/token"), /暂不支持 wiki/);
});

test("reads document metadata and raw content", async () => {
  const client = {
    docx: {
      v1: {
        document: {
          get: async () => ({
            code: 0,
            data: { document: { title: "现有文档", revision_id: 7 } },
          }),
          rawContent: async () => ({
            code: 0,
            data: { content: "正文内容" },
          }),
        },
      },
    },
  };

  const result = await readFeishuDocument({
    client,
    documentId: "doxcn1234567890",
  });
  assert.equal(result.title, "现有文档");
  assert.equal(result.revisionId, 7);
  assert.equal(result.content, "正文内容");
});

test("deletes a docx document through Drive API", async () => {
  const calls = [];
  const client = {
    drive: {
      v1: {
        file: {
          delete: async (payload) => {
            calls.push(payload);
            return { code: 0, data: {} };
          },
        },
      },
    },
  };

  const result = await deleteFeishuDocument({
    client,
    documentId: "doxcn1234567890",
  });
  assert.equal(result.deleted, true);
  assert.deepEqual(calls[0], {
    params: { type: "docx" },
    path: { file_token: "doxcn1234567890" },
  });
});

test("removes a newly created document when body insertion fails", async () => {
  const operations = [];
  const insertionError = {
    response: { status: 400, data: { code: 1770001, msg: "invalid param" } },
  };
  const client = {
    docx: {
      v1: {
        document: {
          convert: async () => ({
            code: 0,
            data: {
              first_level_block_ids: ["block-1"],
              blocks: [{
                block_id: "block-1",
                parent_id: "temporary-root",
                block_type: 2,
                text: { elements: [{ text_run: { content: "正文" } }] },
              }],
            },
          }),
          create: async () => ({
            code: 0,
            data: { document: { document_id: "doc-token" } },
          }),
        },
        documentBlockDescendant: {
          create: async () => {
            operations.push("insert");
            throw insertionError;
          },
        },
      },
    },
    drive: {
      v1: {
        file: {
          delete: async () => {
            operations.push("cleanup");
            return { code: 0 };
          },
        },
      },
    },
  };

  await assert.rejects(
    createFeishuDocument({ client, title: "失败清理测试", content: "正文" }),
    /1770001/,
  );
  assert.deepEqual(operations, ["insert", "cleanup"]);
});

test("lists blocks across pages with plain text", async () => {
  const calls = [];
  const client = {
    docx: {
      v1: {
        documentBlock: {
          list: async (payload) => {
            calls.push(payload);
            if (!payload.params.page_token) {
              return {
                code: 0,
                data: {
                  has_more: true,
                  page_token: "next",
                  items: [{
                    block_id: "block-1",
                    parent_id: "doxcn1234567890",
                    block_type: 2,
                    text: { elements: [{ text_run: { content: "第一段" } }] },
                  }],
                },
              };
            }
            return {
              code: 0,
              data: {
                has_more: false,
                items: [{
                  block_id: "block-2",
                  parent_id: "doxcn1234567890",
                  block_type: 2,
                  text: { elements: [{ equation: { content: "E=mc^2" } }] },
                }],
              },
            };
          },
        },
      },
    },
  };

  const blocks = await listFeishuDocumentBlocks({
    client,
    documentId: "doxcn1234567890",
  });
  assert.deepEqual(blocks.map((block) => block.text), ["第一段", "E=mc^2"]);
  assert.deepEqual(blocks[1].elementKinds, ["equation"]);
  assert.equal(calls[1].params.page_token, "next");
});

test("appends content after existing root children", async () => {
  const calls = [];
  const client = {
    docx: {
      v1: {
        document: {
          convert: async () => ({
            code: 0,
            data: {
              first_level_block_ids: ["new-1"],
              blocks: [{
                block_id: "new-1",
                parent_id: "tmp-root",
                block_type: 2,
                text: { elements: [{ text_run: { content: "新增正文" } }] },
              }],
            },
          }),
        },
        documentBlock: {
          get: async () => ({
            code: 0,
            data: { block: { children: ["old-1", "old-2"] } },
          }),
        },
        documentBlockDescendant: {
          create: async (payload) => {
            calls.push(payload);
            return { code: 0 };
          },
        },
      },
    },
  };

  const result = await appendFeishuDocument({
    client,
    documentId: "doxcn1234567890",
    content: "新增正文",
  });
  assert.equal(calls[0].data.index, 2);
  assert.equal(result.insertedBlocks, 1);
});

test("replaces content by inserting new blocks before deleting old blocks", async () => {
  const operations = [];
  const client = {
    docx: {
      v1: {
        document: {
          convert: async () => ({
            code: 0,
            data: {
              first_level_block_ids: ["new-1"],
              blocks: [{
                block_id: "new-1",
                parent_id: "tmp-root",
                block_type: 2,
                text: { elements: [{ text_run: { content: "替换后的正文" } }] },
              }],
            },
          }),
        },
        documentBlock: {
          get: async () => ({
            code: 0,
            data: { block: { children: ["old-1", "old-2"] } },
          }),
        },
        documentBlockChildren: {
          batchDelete: async (payload) => {
            operations.push(["delete", payload]);
            return { code: 0 };
          },
        },
        documentBlockDescendant: {
          create: async (payload) => {
            operations.push(["create", payload]);
            return { code: 0 };
          },
        },
      },
    },
  };

  const result = await replaceFeishuDocumentContent({
    client,
    documentId: "doxcn1234567890",
    content: "替换后的正文",
  });
  assert.deepEqual(operations.map(([name]) => name), ["create", "delete"]);
  assert.equal(operations[0][1].data.index, 2);
  assert.deepEqual(operations[1][1].data, { start_index: 0, end_index: 2 });
  assert.equal(result.removedBlocks, 2);
});

test("updates a specific text block and renames through the root block", async () => {
  const calls = [];
  const client = {
    docx: {
      v1: {
        document: {
          convert: async () => ({
            code: 0,
            data: {
              first_level_block_ids: ["converted-formula"],
              blocks: [{
                block_id: "converted-formula",
                parent_id: "tmp-root",
                block_type: 2,
                text: { elements: [{ equation: { content: "E=mc^2" } }] },
              }],
            },
          }),
        },
        documentBlock: {
          batchUpdate: async (payload) => {
            calls.push(payload);
            return { code: 0 };
          },
        },
      },
    },
  };

  await updateFeishuDocumentBlock({
    client,
    documentId: "doxcn1234567890",
    blockId: "block-1",
    content: "$$E=mc^2$$",
  });
  await renameFeishuDocument({
    client,
    documentId: "doxcn1234567890",
    title: "新标题",
  });

  assert.equal(calls[0].data.requests[0].block_id, "block-1");
  assert.equal(
    calls[0].data.requests[0].update_text_elements.elements[0].equation.content,
    "E=mc^2",
  );
  assert.equal(calls[1].data.requests[0].block_id, "doxcn1234567890");
  assert.equal(
    calls[1].data.requests[0].update_text_elements.elements[0].text_run.content,
    "新标题",
  );
});
