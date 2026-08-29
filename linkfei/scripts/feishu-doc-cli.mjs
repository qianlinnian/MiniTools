import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(projectRoot);

const silentSdkLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};

const { assertFeishuConfig, loadConfig } = await import("../src/config.mjs");
const {
  appendFeishuDocument,
  createFeishuDocument,
  deleteFeishuDocument,
  listFeishuDocumentBlocks,
  normalizeFeishuDocumentId,
  readFeishuDocument,
  renameFeishuDocument,
  replaceFeishuDocumentContent,
  updateFeishuDocumentBlock,
} = await import("../src/feishu-docs.mjs");

const HELP = `LinkFei 飞书文档操作

用法：
  node scripts/feishu-doc-cli.mjs create --title <标题> (--content <正文> | --content-file <文件>)
  node scripts/feishu-doc-cli.mjs read --document <链接或ID>
  node scripts/feishu-doc-cli.mjs blocks --document <链接或ID>
  node scripts/feishu-doc-cli.mjs append --document <链接或ID> (--content <正文> | --content-file <文件>)
  node scripts/feishu-doc-cli.mjs update-block --document <链接或ID> --block-id <块ID> (--content <正文> | --content-file <文件>)
  node scripts/feishu-doc-cli.mjs rename --document <链接或ID> --title <新标题>
  node scripts/feishu-doc-cli.mjs replace --document <链接或ID> --confirm-document <同一ID> (--content <正文> | --content-file <文件>)
  node scripts/feishu-doc-cli.mjs delete --document <链接或ID> --confirm-document <同一ID>

说明：replace 会替换整篇正文；delete 会把文档移入回收站。两者都必须用 --confirm-document 再次提供相同 document_id。`;

function parseArgs(argv) {
  const [action = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith("--")) throw new Error(`无法识别的参数：${name}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${name} 缺少值。`);
    }
    options[name.slice(2)] = value;
    index += 1;
  }
  return { action, options };
}

function requireOption(options, name) {
  const value = options[name]?.trim();
  if (!value) throw new Error(`缺少 --${name}。`);
  return value;
}

function getContent(options) {
  if (options["content-file"]) {
    return readFileSync(options["content-file"], "utf8");
  }
  if (Object.hasOwn(options, "content")) return options.content;
  throw new Error("请提供 --content 或 --content-file。");
}

async function main() {
  const { action, options } = parseArgs(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(action)) {
    console.log(HELP);
    return;
  }

  const config = loadConfig();
  assertFeishuConfig(config);
  const client = new Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    // SDK 1.x treats the numeric fatal level (0) as a missing value. Use a
    // no-op logger as the actual safeguard against raw request metadata.
    loggerLevel: LoggerLevel.error,
    logger: silentSdkLogger,
  });
  const common = {
    client,
    docBaseUrl: config.feishu.docBaseUrl,
  };

  let result;
  if (action === "create") {
    result = await createFeishuDocument({
      ...common,
      title: requireOption(options, "title"),
      content: getContent(options),
    });
  } else if (action === "read") {
    result = await readFeishuDocument({
      ...common,
      documentId: requireOption(options, "document"),
    });
  } else if (action === "blocks") {
    result = {
      documentId: normalizeFeishuDocumentId(requireOption(options, "document")),
      blocks: await listFeishuDocumentBlocks({
        client,
        documentId: requireOption(options, "document"),
      }),
    };
  } else if (action === "append") {
    result = await appendFeishuDocument({
      ...common,
      documentId: requireOption(options, "document"),
      content: getContent(options),
    });
  } else if (action === "update-block") {
    result = await updateFeishuDocumentBlock({
      ...common,
      documentId: requireOption(options, "document"),
      blockId: requireOption(options, "block-id"),
      content: getContent(options),
    });
  } else if (action === "rename") {
    result = await renameFeishuDocument({
      ...common,
      documentId: requireOption(options, "document"),
      title: requireOption(options, "title"),
    });
  } else if (action === "replace") {
    const documentId = normalizeFeishuDocumentId(
      requireOption(options, "document"),
    );
    const confirmation = normalizeFeishuDocumentId(
      requireOption(options, "confirm-document"),
    );
    if (confirmation !== documentId) {
      throw new Error("--confirm-document 与目标 document_id 不一致，已拒绝替换。");
    }
    result = await replaceFeishuDocumentContent({
      ...common,
      documentId,
      content: getContent(options),
    });
  } else if (action === "delete") {
    const documentId = normalizeFeishuDocumentId(
      requireOption(options, "document"),
    );
    const confirmation = normalizeFeishuDocumentId(
      requireOption(options, "confirm-document"),
    );
    if (confirmation !== documentId) {
      throw new Error("--confirm-document 与目标 document_id 不一致，已拒绝删除。");
    }
    result = await deleteFeishuDocument({
      ...common,
      documentId,
    });
  } else {
    throw new Error(`未知操作：${action}\n\n${HELP}`);
  }

  console.log(JSON.stringify({ ok: true, action, result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || "未知错误",
    feishuCode: error?.feishu?.code,
  }, null, 2));
  process.exitCode = 1;
});
