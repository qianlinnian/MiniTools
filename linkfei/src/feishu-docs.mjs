const MAX_BLOCK_CHARS = 1_500;
const DOCUMENT_PERMISSION_CODE = 99991672;
const MARKDOWN_CONVERT_SCOPE = "docx:document.block:convert";
const DOCUMENT_DELETE_SCOPE = "space:document:delete";

function documentUrl(documentId, docBaseUrl = "https://feishu.cn/docx") {
  return `${docBaseUrl.replace(/\/+$/, "")}/${documentId}`;
}

function splitLongText(text, maxChars = MAX_BLOCK_CHARS) {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += maxChars) {
    chunks.push(text.slice(offset, offset + maxChars));
  }
  return chunks;
}

export function contentToTextBlocks(content) {
  const paragraphs = content
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) => splitLongText(paragraph));

  const safeParagraphs = paragraphs.length ? paragraphs : ["（无正文内容）"];
  return safeParagraphs.map((paragraph) => ({
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content: paragraph,
          },
        },
      ],
    },
  }));
}

function assertApiSuccess(response, action) {
  if (response?.code && response.code !== 0) {
    throw new Error(`${action}失败（${response.code}）：${response.msg || "未知错误"}`);
  }
}

export function getFeishuErrorDetails(error) {
  const data = error?.response?.data ?? error?.data;
  if (!data || typeof data !== "object") {
    return null;
  }

  return {
    code: data.code,
    message: data.msg || data.message,
    logId:
      data.log_id ??
      data.error?.log_id ??
      error?.response?.headers?.["x-tt-logid"],
    status: error?.response?.status,
  };
}

export function formatFeishuError(error, action = "调用飞书接口") {
  const details = getFeishuErrorDetails(error);

  if (
    details?.code === DOCUMENT_PERMISSION_CODE &&
    details?.message?.includes(MARKDOWN_CONVERT_SCOPE)
  ) {
    return `${action}失败：应用缺少飞书 Markdown 转块权限（${MARKDOWN_CONVERT_SCOPE}）。请在飞书开放平台开通应用身份权限后重试。`;
  }

  if (
    details?.code === DOCUMENT_PERMISSION_CODE &&
    (details?.message?.includes(DOCUMENT_DELETE_SCOPE) ||
      action.includes("删除飞书文档"))
  ) {
    return `${action}失败：应用缺少删除云文档权限（${DOCUMENT_DELETE_SCOPE}）。请在飞书开放平台开通应用身份权限后重试。`;
  }

  if (details?.code === DOCUMENT_PERMISSION_CODE) {
    return `${action}失败：应用缺少“创建及编辑新版文档”权限（docx:document 或 docx:document:create）。请在飞书开放平台开通应用身份权限、发布新版本并完成管理员审批后重试。`;
  }

  if (details?.code) {
    return `${action}失败（飞书错误 ${details.code}）：${details.message || "未知错误"}`;
  }

  return `${action}失败：${error?.message || "未知错误"}`;
}

async function callFeishuApi(action, request) {
  try {
    const response = await request();
    assertApiSuccess(response, action);
    return response;
  } catch (error) {
    const wrapped = new Error(formatFeishuError(error, action), { cause: error });
    wrapped.feishu = getFeishuErrorDetails(error);
    throw wrapped;
  }
}

export function normalizeFeishuDocumentId(value) {
  const input = String(value || "").trim();
  if (/^[A-Za-z0-9_-]{8,}$/.test(input)) return input;

  try {
    const url = new URL(input);
    const segments = url.pathname.split("/").filter(Boolean);
    const docxIndex = segments.indexOf("docx");
    const token = docxIndex >= 0 ? segments[docxIndex + 1] : undefined;
    if (token && /^[A-Za-z0-9_-]{8,}$/.test(token)) return token;
  } catch {
    // Fall through to the actionable validation error below.
  }

  throw new Error("请提供飞书新版文档的 docx 链接或 document_id。暂不支持 wiki 链接。");
}

function textElements(content) {
  return [
    {
      text_run: {
        content,
      },
    },
  ];
}

function blockText(block) {
  return blockElements(block)
    .map((element) =>
      element?.text_run?.content ??
      element?.equation?.content ??
      element?.mention_doc?.title ??
      "",
    )
    .join("");
}

function blockElements(block) {
  for (const value of Object.values(block || {})) {
    if (value && typeof value === "object" && Array.isArray(value.elements)) {
      return value.elements;
    }
  }
  return [];
}

async function getRootBlock(client, documentId) {
  const response = await callFeishuApi("读取飞书文档根块", () =>
    client.docx.v1.documentBlock.get({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
    }),
  );
  return response?.data?.block;
}

export async function convertMarkdownToFeishuBlocks({ client, content }) {
  const markdown = String(content ?? "").trim()
    ? String(content).replace(/\r\n/g, "\n")
    : "（无正文内容）";
  const response = await callFeishuApi("转换 Markdown 为飞书文档块", () =>
    client.docx.v1.document.convert({
      data: {
        content_type: "markdown",
        content: markdown,
      },
    }),
  );
  const childrenIds = response?.data?.first_level_block_ids || [];
  const blocks = response?.data?.blocks || [];
  if (!childrenIds.length || !blocks.length) {
    throw new Error("飞书 Markdown 转换成功，但没有返回可写入的文档块。");
  }

  return {
    childrenIds,
    descendants: blocks.map(({ parent_id: _parentId, ...block }) => {
      // Feishu's converter returns merge_info for tables, but that field is
      // read-only and must be removed before calling the descendant API.
      if (block.table?.property) {
        const { merge_info: _mergeInfo, ...property } = block.table.property;
        return {
          ...block,
          table: {
            ...block.table,
            property,
          },
        };
      }
      return block;
    }),
  };
}

async function insertConvertedBlocks({
  client,
  documentId,
  converted,
  index,
}) {
  await callFeishuApi("写入飞书 Markdown 文档块", () =>
    client.docx.v1.documentBlockDescendant.create({
      data: {
        children_id: converted.childrenIds,
        descendants: converted.descendants,
        index,
      },
      path: {
        document_id: documentId,
        block_id: documentId,
      },
    }),
  );
}

export async function createFeishuDocument({
  client,
  title,
  content,
  docBaseUrl = "https://feishu.cn/docx",
}) {
  // Convert first so a missing conversion permission cannot leave an empty doc.
  const converted = await convertMarkdownToFeishuBlocks({ client, content });
  const createResponse = await callFeishuApi("创建飞书文档", () =>
    client.docx.v1.document.create({
      data: { title },
    }),
  );

  const documentId = createResponse?.data?.document?.document_id;
  if (!documentId) {
    throw new Error("飞书创建文档成功，但响应中没有 document_id。");
  }

  try {
    await insertConvertedBlocks({
      client,
      documentId,
      converted,
      index: 0,
    });
  } catch (error) {
    // A failed body insertion must not leave an empty document behind. Keep
    // the original write error even if cleanup itself is unavailable.
    try {
      await deleteFeishuDocument({ client, documentId, docBaseUrl });
    } catch {
      // Preserve the actionable insertion error.
    }
    throw error;
  }

  return {
    documentId,
    title,
    url: documentUrl(documentId, docBaseUrl),
  };
}

export async function readFeishuDocument({
  client,
  documentId: input,
  docBaseUrl = "https://feishu.cn/docx",
}) {
  const documentId = normalizeFeishuDocumentId(input);
  const [documentResponse, contentResponse] = await Promise.all([
    callFeishuApi("读取飞书文档信息", () =>
      client.docx.v1.document.get({
        path: { document_id: documentId },
      }),
    ),
    callFeishuApi("读取飞书文档正文", () =>
      client.docx.v1.document.rawContent({
        path: { document_id: documentId },
      }),
    ),
  ]);

  return {
    documentId,
    title: documentResponse?.data?.document?.title || "",
    revisionId: documentResponse?.data?.document?.revision_id,
    content: contentResponse?.data?.content || "",
    url: documentUrl(documentId, docBaseUrl),
  };
}

export async function deleteFeishuDocument({
  client,
  documentId: input,
  docBaseUrl = "https://feishu.cn/docx",
}) {
  const documentId = normalizeFeishuDocumentId(input);
  const response = await callFeishuApi("删除飞书文档", () =>
    client.drive.v1.file.delete({
      params: { type: "docx" },
      path: { file_token: documentId },
    }),
  );

  return {
    documentId,
    deleted: true,
    taskId: response?.data?.task_id,
    url: documentUrl(documentId, docBaseUrl),
  };
}

export async function listFeishuDocumentBlocks({ client, documentId: input }) {
  const documentId = normalizeFeishuDocumentId(input);
  const items = [];
  let pageToken;

  do {
    const response = await callFeishuApi("读取飞书文档块", () =>
      client.docx.v1.documentBlock.list({
        params: {
          page_size: 500,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
        path: { document_id: documentId },
      }),
    );
    items.push(...(response?.data?.items || []));
    pageToken = response?.data?.has_more
      ? response?.data?.page_token
      : undefined;
    if (response?.data?.has_more && !pageToken) {
      throw new Error("飞书返回 has_more，但没有 page_token。");
    }
  } while (pageToken);

  return items.map((block) => ({
    blockId: block.block_id,
    parentId: block.parent_id,
    blockType: block.block_type,
    text: blockText(block),
    elementKinds: blockElements(block).map(
      (element) => Object.keys(element)[0] || "unknown",
    ),
    childCount: block.children?.length || 0,
  }));
}

export async function appendFeishuDocument({
  client,
  documentId: input,
  content,
  docBaseUrl = "https://feishu.cn/docx",
}) {
  const documentId = normalizeFeishuDocumentId(input);
  const converted = await convertMarkdownToFeishuBlocks({ client, content });
  const root = await getRootBlock(client, documentId);
  const index = root?.children?.length || 0;
  await insertConvertedBlocks({
    client,
    documentId,
    converted,
    index,
  });

  return {
    documentId,
    insertedBlocks: converted.childrenIds.length,
    insertedDescendants: converted.descendants.length,
    url: documentUrl(documentId, docBaseUrl),
  };
}

export async function replaceFeishuDocumentContent({
  client,
  documentId: input,
  content,
  docBaseUrl = "https://feishu.cn/docx",
}) {
  const documentId = normalizeFeishuDocumentId(input);
  const converted = await convertMarkdownToFeishuBlocks({ client, content });
  const root = await getRootBlock(client, documentId);
  const oldBlockCount = root?.children?.length || 0;

  // Insert first. If insertion fails, the old document remains untouched.
  await insertConvertedBlocks({
    client,
    documentId,
    converted,
    index: oldBlockCount,
  });

  if (oldBlockCount > 0) {
    await callFeishuApi("删除飞书文档旧正文", () =>
      client.docx.v1.documentBlockChildren.batchDelete({
        data: {
          start_index: 0,
          end_index: oldBlockCount,
        },
        path: {
          document_id: documentId,
          block_id: documentId,
        },
      }),
    );
  }

  return {
    documentId,
    removedBlocks: oldBlockCount,
    insertedBlocks: converted.childrenIds.length,
    insertedDescendants: converted.descendants.length,
    url: documentUrl(documentId, docBaseUrl),
  };
}

export async function updateFeishuDocumentBlock({
  client,
  documentId: input,
  blockId,
  content,
  docBaseUrl = "https://feishu.cn/docx",
}) {
  const documentId = normalizeFeishuDocumentId(input);
  if (!blockId?.trim()) throw new Error("缺少 block_id。");
  const markdown = String(content ?? "");
  if (markdown.length > MAX_BLOCK_CHARS) {
    throw new Error(`单个块内容不能超过 ${MAX_BLOCK_CHARS} 个字符，请改用追加或整篇替换。`);
  }
  const converted = await convertMarkdownToFeishuBlocks({
    client,
    content: markdown,
  });
  if (converted.childrenIds.length !== 1) {
    throw new Error("块级修改只能生成一个顶层块；多段内容请使用追加或整篇替换。");
  }
  const convertedBlock = converted.descendants.find(
    (block) => block.block_id === converted.childrenIds[0],
  );
  const elements = blockElements(convertedBlock);
  if (!elements.length || convertedBlock?.children?.length) {
    throw new Error("块级修改只支持单个文本型 Markdown 块。");
  }

  await callFeishuApi("更新飞书文档块", () =>
    client.docx.v1.documentBlock.batchUpdate({
      data: {
        requests: [
          {
            block_id: blockId.trim(),
            update_text_elements: {
              elements,
            },
          },
        ],
      },
      path: { document_id: documentId },
    }),
  );

  return {
    documentId,
    blockId: blockId.trim(),
    url: documentUrl(documentId, docBaseUrl),
  };
}

export async function renameFeishuDocument({
  client,
  documentId: input,
  title,
  docBaseUrl = "https://feishu.cn/docx",
}) {
  const documentId = normalizeFeishuDocumentId(input);
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) throw new Error("文档标题不能为空。");

  await callFeishuApi("更新飞书文档标题", () =>
    client.docx.v1.documentBlock.batchUpdate({
      data: {
        requests: [
          {
            block_id: documentId,
            update_text_elements: {
              elements: textElements(normalizedTitle),
            },
          },
        ],
      },
      path: { document_id: documentId },
    }),
  );

  return {
    documentId,
    title: normalizedTitle,
    url: documentUrl(documentId, docBaseUrl),
  };
}
