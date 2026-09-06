import "dotenv/config";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(resolve(process.env.LINKFEI_DB_PATH || "data/linkfei.sqlite"), { readOnly: true });
try {
  const recipient = database.prepare("SELECT chat_id,user_id FROM notification_recipients WHERE id = 1").get();
  if (!recipient?.user_id || !recipient.chat_id || recipient.user_id.startsWith("chat:")) throw new Error("缺少已绑定的个人收件人；请先通过自己的飞书私聊执行 /notify bind。");
  const path = resolve("data/codex-remote.json");
  const projectRoot = resolve("../..");
  const serviceRoot = resolve(".");
  const legacyProjects = { linkfei: serviceRoot, minitools: resolve("..") };
  const defaultProjects = { linkfei: projectRoot, "linkfei-service": serviceRoot };
  if (existsSync(path)) {
    const current = JSON.parse(readFileSync(path, "utf8"));
    if (current.ownerId !== recipient.user_id || current.chatId !== recipient.chat_id) throw new Error("已有不同的远程控制授权；不会自动替换。");
    const isLegacy = JSON.stringify(current.projects) === JSON.stringify(legacyProjects);
    if (isLegacy) {
      writeFileSync(path, JSON.stringify({ ...current, projects: defaultProjects }, null, 2), { mode: 0o600 });
      console.log("已迁移项目别名：linkfei 指向 MiniTools 项目根；linkfei-service 指向 LinkFei 子目录。重启后生效。");
    } else console.log("Codex 远程授权已存在，保持自定义项目配置。");
  } else {
    writeFileSync(path, JSON.stringify({ enabled: true, ownerId: recipient.user_id, chatId: recipient.chat_id,
      projects: defaultProjects }, null, 2), { mode: 0o600 });
    console.log("已固定授权到现有个人收件人，项目：linkfei、linkfei-service。重启 LinkFei 后生效。");
  }
} finally { database.close(); }
