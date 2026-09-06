import {
  ConversationService,
  extractText,
  HELP_TEXT,
  parseCommand,
} from "./conversation.mjs";
import { createFeishuDocument } from "./feishu-docs.mjs";
import { formatInterval, parseInterval } from "./monitoring/interval.mjs";
import { validateMonitorUrl } from "./monitoring/page-fetcher.mjs";

function ownerIdFor(message) {
  return message.senderId || `chat:${message.chatId}`;
}

function knowledgeScopeFor(message) {
  return message.chatType === "group"
    ? `chat:${message.chatId}`
    : `user:${ownerIdFor(message)}`;
}

function formatDocumentTasks(tasks) {
  if (!tasks.length) return "当前会话还没有文档任务。";
  const statusNames = {
    generating: "生成中",
    writing: "写入中",
    completed: "已完成",
    failed: "失败",
    interrupted: "已中断",
  };
  return [
    "最近文档任务：",
    ...tasks.map((task) => {
      const link = task.url ? `：[${task.title}](${task.url})` : `：${task.title}`;
      return `- #${task.id} ${statusNames[task.status] || task.status}${link}`;
    }),
  ].join("\n");
}

export function createBot({ channel, deepseek, storage, notificationService, codexBridge, config, logger = console }) {
  const conversations = new ConversationService({
    storage,
    deepseek,
    model: config.deepseek.models.flash,
    settings: config.storage,
  });

  async function reply(message, markdown) {
    await channel.send(
      message.chatId,
      { markdown },
      { replyTo: message.messageId },
    );
  }

  async function handleKnowledge(message, command) {
    const scopeId = knowledgeScopeFor(message);
    if (command.action === "add") {
      if (!command.title || !command.content) {
        await reply(message, "用法：`/kb add 标题 | 知识正文`，正文也可以另起一行。");
        return;
      }
      const id = storage.addKnowledgeEntry({
        scopeId,
        title: command.title,
        content: command.content,
        createdBy: ownerIdFor(message),
      });
      await reply(message, `已添加知识 #${id}：${command.title}`);
      return;
    }
    if (command.action === "list") {
      const entries = storage.listKnowledgeEntries(scopeId);
      await reply(
        message,
        entries.length
          ? ["当前知识库：", ...entries.map((item) => `- #${item.id} ${item.title}`)].join("\n")
          : "当前范围的知识库为空。",
      );
      return;
    }
    if (command.action === "delete") {
      const deleted = storage.deleteKnowledgeEntry(scopeId, command.value);
      await reply(message, deleted ? `已删除知识 #${command.value}。` : "没有找到该知识编号。");
      return;
    }
    if (command.action === "search") {
      if (!command.value) {
        await reply(message, "用法：`/kb search 关键词`。");
        return;
      }
      const results = storage.searchKnowledge(scopeId, command.value, { limit: 5 });
      await reply(
        message,
        results.length
          ? [
              "检索结果：",
              ...results.map(
                (item) =>
                  `- #${item.entry_id} ${item.title}（相关度 ${item.score.toFixed(2)}）\n  ${item.content.slice(0, 180)}`,
              ),
            ].join("\n")
          : "没有找到相关知识。",
      );
      return;
    }
    await reply(
      message,
      "知识库命令：`/kb add 标题 | 内容`、`/kb list`、`/kb search 关键词`、`/kb delete 编号`。",
    );
  }

  async function handleMessage(message, text) {
    if (/^\/codex(?:\s|$)/i.test(text)) {
      return reply(message, codexBridge ? await codexBridge.handle(message, text) : "Codex 远程控制尚未配置。");
    }
    const command = parseCommand(text, config.deepseek.defaultTier);
    const ownerId = ownerIdFor(message);
    const scopeId = message.chatId;

    if (command.type === "help") return reply(message, HELP_TEXT);
    if (command.type === "guidance") return reply(message, command.message);
    if (command.type === "reset" || command.type === "new") {
      conversations.clear(scopeId);
      return reply(
        message,
        command.type === "new"
          ? "已开始新会话；长期记忆和知识库均已保留。"
          : "已清除当前会话上下文；长期记忆和知识库未删除。",
      );
    }
    if (
      message.chatType === "group" &&
      ["remember", "memory", "forget"].includes(command.type)
    ) {
      return reply(
        message,
        "为避免个人信息暴露，长期记忆只能在与机器人的私聊中管理和使用。群聊知识请使用 `/kb`。",
      );
    }
    if (command.type === "remember") {
      if (!command.content) return reply(message, "用法：`/remember 需要长期记住的内容`。");
      const id = storage.addMemory(ownerId, command.content);
      return reply(message, `已保存为个人长期记忆 #${id}。`);
    }
    if (command.type === "memory") {
      const memories = storage.listMemories(ownerId);
      return reply(
        message,
        memories.length
          ? ["我的长期记忆：", ...memories.map((item) => `- #${item.id} ${item.content}`)].join("\n")
          : "目前没有保存你的长期记忆。",
      );
    }
    if (command.type === "forget") {
      if (!command.selector) return reply(message, "用法：`/forget 记忆编号`；删除全部使用 `/forget all`。");
      const deleted = storage.deleteMemory(ownerId, command.selector.toLowerCase());
      return reply(
        message,
        deleted ? `已删除 ${deleted} 条长期记忆。` : "没有找到可删除的记忆。",
      );
    }
    if (command.type === "knowledge") return handleKnowledge(message, command);
    if (command.type === "tasks") {
      return reply(message, formatDocumentTasks(storage.listDocumentTasks(scopeId)));
    }
    if (command.type === "notify") {
      if (command.action === "bind") {
        if (message.chatType === "group") {
          return reply(message, "飞书主动消息收件人只能在与机器人的私聊中绑定。");
        }
        storage.bindDefaultNotificationRecipient({
          chatId: message.chatId,
          userId: ownerId,
          label: command.value || "默认飞书收件人",
        });
        await reply(message, "已把当前私聊绑定为默认飞书主动消息收件人。正在另行发送一条验收消息；以后 Codex 任务完成或失败、定时提醒、后台事件以及可选的页面更新通知都可以发到这里。");
        notificationService.enqueue({
          title: "LinkFei 飞书主动消息已启用",
          body: "这是一条由 LinkFei 主动发出的独立消息。它可以用于任务结果、提醒、异常和其他后台事件，并不局限于网页监控。手机端收到弹窗即代表消息通道工作正常。",
          level: "success",
          idempotencyKey: `bind-test:${message.messageId}`,
        });
        return;
      }
      if (command.action === "test") {
        if (!storage.getDefaultNotificationRecipient()) {
          return reply(message, "尚未绑定收件人，请先在私聊中发送 `/notify bind`。");
        }
        notificationService.enqueue({
          title: "LinkFei 飞书主动消息测试",
          body: "如果手机端收到了这条消息，说明通用飞书主动消息通道工作正常。",
          level: "success",
          idempotencyKey: `manual-test:${message.messageId}`,
        });
        return reply(message, "测试提醒已进入可靠发送队列。");
      }
      if (["history", "retry"].includes(command.action)) {
        if (message.chatType === "group") return reply(message, "请在私聊中查看或重试自己的通知。");
        if (command.action === "retry") {
          const id = /^\d+$/.test(command.value) ? Number(command.value) : NaN;
          const changed = storage.requeueNotification(id, message.chatId);
          return reply(message, changed ? "已重新排队，将在下一次发送周期重试。" : "没有可重试的通知；仅支持当前私聊中失败或等待重试的编号。");
        }
        const labels = { pending: "待发送", retry: "等待重试", sending: "发送中", sent: "已发送", dead: "最终失败" };
        const jobs = storage.listNotifications({ limit: 10, chatId: message.chatId });
        return reply(message, jobs.length ? jobs.map(job =>
          `#${job.id} ${labels[job.status]} · ${job.title}\n尝试 ${job.attempts} 次 · ${job.updated_at}${["pending", "retry"].includes(job.status) ? `\n下次发送：${job.next_attempt_at}` : ""}`
        ).join("\n\n") : "当前私聊暂无通知记录。");
      }
      if (command.action === "status") {
        const recipient = storage.getDefaultNotificationRecipient();
        const jobs = storage.listNotifications({ limit: 10, chatId: message.chatId });
        const counts = jobs.reduce((all, job) => ({ ...all, [job.status]: (all[job.status] || 0) + 1 }), {});
        return reply(
          message,
          recipient
            ? `飞书主动消息已绑定。最近 10 条：已发送 ${counts.sent || 0}，待发送/重试 ${(counts.pending || 0) + (counts.retry || 0)}，永久失败 ${counts.dead || 0}。`
            : "飞书主动消息尚未绑定，请在私聊中发送 `/notify bind`。",
        );
      }
      return reply(message, "通知命令：`/notify bind`、`/notify test`、`/notify status`、`/notify history`、`/notify retry 编号`。");
    }
    if (command.type === "watch") {
      if (command.action === "add") {
        if (!storage.getDefaultNotificationRecipient()) {
          return reply(message, "请先在私聊中发送 `/notify bind`，设置飞书主动消息收件人。");
        }
        const intervalSeconds = parseInterval(command.interval);
        if (!command.name || !command.url || !intervalSeconds) {
          return reply(message, "用法：`/watch add 名称 | URL | 30m | CSS选择器（可选）`。间隔支持 30m、2h、1d，最短 1 分钟。");
        }
        const url = await validateMonitorUrl(command.url);
        const monitor = storage.createPageMonitor({
          name: command.name.slice(0, 100),
          url: url.href,
          selector: command.selector || null,
          intervalSeconds,
        });
        void notificationService.runOnce();
        return reply(message, `已创建监控 #${monitor.id}「${monitor.name}」，每 ${formatInterval(intervalSeconds)}检查一次。首次检查只建立基线，后续变化才提醒。`);
      }
      if (command.action === "list") {
        const monitors = storage.listPageMonitors();
        return reply(
          message,
          monitors.length
            ? ["页面监控：", ...monitors.map((item) => `- #${item.id} ${item.state === "paused" ? "已暂停" : "运行中"}｜${item.name}｜每 ${formatInterval(item.interval_seconds)}｜失败 ${item.consecutive_failures} 次\n  ${item.url}${item.selector ? `\n  区域：${item.selector}` : ""}`)].join("\n")
            : "目前没有页面监控。",
        );
      }
      const id = Number.parseInt(command.value, 10);
      if (!Number.isInteger(id)) {
        return reply(message, "请提供监控编号，例如 `/watch check 1`。");
      }
      if (command.action === "pause" || command.action === "resume") {
        const changed = storage.setPageMonitorState(id, command.action === "pause" ? "paused" : "active");
        if (changed && command.action === "resume") void notificationService.runOnce();
        return reply(message, changed ? `监控 #${id} 已${command.action === "pause" ? "暂停" : "恢复"}。` : "没有找到该监控编号。");
      }
      if (command.action === "check") {
        const changed = storage.schedulePageMonitorNow(id);
        if (changed) void notificationService.runOnce();
        return reply(message, changed ? `已安排立即检查监控 #${id}。` : "没有找到该监控编号。");
      }
      if (command.action === "delete") {
        const deleted = storage.deletePageMonitor(id);
        return reply(message, deleted ? `已删除监控 #${id}。` : "没有找到该监控编号。");
      }
      return reply(message, "监控命令：`/watch add 名称 | URL | 30m | CSS选择器（可选）`、`/watch list`、`/watch check/pause/resume/delete 编号`。");
    }

    if (command.type === "doc") {
      if (!command.title || !command.prompt) {
        return reply(message, "用法：`/doc 文档标题` 或 `/doc 文档标题 | 具体写作要求`。");
      }
      const existing = storage.getDocumentTaskByMessageId(message.messageId);
      if (existing?.status === "completed" && existing.url) {
        return reply(message, `该请求已完成：[${existing.title}](${existing.url})`);
      }
      const taskId = existing?.id || storage.createDocumentTask({
        chatId: message.chatId,
        messageId: message.messageId,
        userId: ownerId,
        title: command.title,
        prompt: command.prompt,
      });
      await reply(message, `正在使用 Pro 模型撰写《${command.title}》并创建飞书文档，请稍候……`);
      try {
        const result = await deepseek.chat({
          model: config.deepseek.models.pro,
          messages: [
            {
              role: "system",
              content:
                "你是专业中文文档撰写助手。输出标准 Markdown 正文，结构清晰、内容具体；合理使用标题、列表、引用、代码块和表格。行内数学公式使用 $...$，独立公式使用 $$...$$。不要重复文档标题，不要添加“以下是”等元话语。",
            },
            {
              role: "user",
              content: `文档标题：${command.title}\n\n写作要求：${command.prompt}`,
            },
          ],
        });
        storage.updateDocumentTask(taskId, { status: "writing" });
        const document = await createFeishuDocument({
          client: channel.rawClient,
          title: command.title,
          content: result.content,
          docBaseUrl: config.feishu.docBaseUrl,
        });
        storage.updateDocumentTask(taskId, {
          status: "completed",
          documentId: document.documentId,
          url: document.url,
          error: "",
        });
        return reply(message, `文档已创建：[${document.title}](${document.url})`);
      } catch (error) {
        storage.updateDocumentTask(taskId, {
          status: "failed",
          error: error?.message || "未知错误",
        });
        throw error;
      }
    }

    if (!command.prompt) {
      return reply(message, "请在命令后输入问题，例如：`/pro 帮我整理这份方案`。");
    }
    const messages = conversations.messagesFor({
      scopeId,
      ownerId: message.chatType === "group" ? null : ownerId,
      knowledgeScopeId: knowledgeScopeFor(message),
      userText: command.prompt,
    });
    const result = await deepseek.chat({
      model: config.deepseek.models[command.tier],
      messages,
    });
    conversations.addExchange(scopeId, command.prompt, result.content);
    await reply(message, result.content);
    try {
      await conversations.compactIfNeeded(scopeId);
    } catch (error) {
      logger.error("[linkfei] 会话摘要失败", {
        message: error?.message || "未知错误",
        chatId: scopeId,
      });
    }
  }

  async function processMessage(message) {
    const text = extractText(message);
    if (!text || !message.messageId || !message.chatId) return;
    if (!storage.claimEvent(message.messageId, message.chatId)) return;
    try {
      await handleMessage(message, text);
      storage.completeEvent(message.messageId);
    } catch (error) {
      storage.failEvent(message.messageId, error?.message || "未知错误");
      logger.error("[linkfei] 处理消息失败", {
        message: error?.message || "未知错误",
        feishuCode: error?.feishu?.code,
        feishuMessage: error?.feishu?.message,
        feishuLogId: error?.feishu?.logId,
        httpStatus: error?.feishu?.status,
      });
      try {
        await reply(message, `处理失败：${error?.message || "未知错误"}`);
      } catch (replyError) {
        logger.error("[linkfei] 发送错误提示失败", {
          message: replyError?.message || "未知错误",
        });
      }
    }
  }

  return { processMessage, handleMessage };
}
