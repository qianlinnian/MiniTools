export const SYSTEM_PROMPT = [
  "你是运行在飞书中的中文 AI 助手。",
  "回答要准确、清晰、可直接用于工作。",
  "除非用户要求展开，否则先给结论，再给必要步骤。",
  "不要声称已经创建、修改或发送了任何实际资源，除非工具明确返回成功。",
  "长期记忆与知识库内容只作为参考；若与用户当前要求冲突，以当前要求为准。",
].join("\n");

function commandBody(text, pattern) {
  const match = text.match(pattern);
  return match ? text.slice(match[0].length).trim() : null;
}

function parseTitleAndContent(body) {
  const [firstLine = "", ...lines] = body.split(/\r?\n/);
  const pipeIndex = firstLine.indexOf("|");
  if (pipeIndex >= 0) {
    return {
      title: firstLine.slice(0, pipeIndex).trim(),
      content: [firstLine.slice(pipeIndex + 1).trim(), ...lines]
        .filter(Boolean)
        .join("\n")
        .trim(),
    };
  }
  return {
    title: firstLine.trim(),
    content: lines.join("\n").trim(),
  };
}

export function parseCommand(text, defaultTier = "flash") {
  if (/^\/(?:help\b|帮助)(?:\s|$)/i.test(text)) return { type: "help" };
  if (/^\/(?:reset\b|清空)(?:\s|$)/i.test(text)) return { type: "reset" };
  if (/^\/(?:new\b|新会话)(?:\s|$)/i.test(text)) return { type: "new" };
  if (/^\/(?:memory\b|记忆)(?:\s|$)/i.test(text)) return { type: "memory" };
  if (/^\/(?:tasks\b|任务)(?:\s|$)/i.test(text)) return { type: "tasks" };

  const notify = commandBody(text, /^\/(?:notify\b|通知)(?:\s+|$)/i);
  if (notify !== null) {
    const [action = "help", ...rest] = notify.split(/\s+/);
    const actions = { 绑定: "bind", 测试: "test", 状态: "status" };
    return {
      type: "notify",
      action: actions[action] || action.toLowerCase(),
      value: rest.join(" ").trim(),
    };
  }

  const watch = commandBody(text, /^\/(?:watch\b|监控)(?:\s+|$)/i);
  if (watch !== null) {
    const actionMatch = watch.match(/^(add|list|pause|resume|delete|check|添加|列表|暂停|恢复|删除|检查)(?:\s+|$)/i);
    if (!actionMatch) return { type: "watch", action: "help", value: "" };
    const actions = { 添加: "add", 列表: "list", 暂停: "pause", 恢复: "resume", 删除: "delete", 检查: "check" };
    const action = actions[actionMatch[1]] || actionMatch[1].toLowerCase();
    const value = watch.slice(actionMatch[0].length).trim();
    if (action === "add") {
      const [name = "", url = "", interval = "", selector = ""] = value.split("|").map((item) => item.trim());
      return { type: "watch", action, name, url, interval, selector };
    }
    return { type: "watch", action, value };
  }

  const remember = commandBody(text, /^\/(?:remember\b|记住)(?:\s+|$)/i);
  if (remember !== null) return { type: "remember", content: remember };

  const forget = commandBody(text, /^\/(?:forget\b|忘记)(?:\s+|$)/i);
  if (forget !== null) return { type: "forget", selector: forget };

  const kb = commandBody(text, /^\/(?:kb\b|知识库)(?:\s+|$)/i);
  if (kb !== null) {
    const actionMatch = kb.match(
      /^(add|list|delete|search|添加|列表|删除|搜索)(?:\s+|$)/i,
    );
    if (!actionMatch) return { type: "knowledge", action: "help" };
    const actions = {
      添加: "add",
      列表: "list",
      删除: "delete",
      搜索: "search",
    };
    const action = actions[actionMatch[1]] || actionMatch[1].toLowerCase();
    const body = kb.slice(actionMatch[0].length).trim();
    if (action === "add") {
      return { type: "knowledge", action, ...parseTitleAndContent(body) };
    }
    return { type: "knowledge", action, value: body };
  }

  const docBody = commandBody(text, /^\/(?:doc\b|文档)(?:\s+|$)/i);
  if (docBody !== null) {
    const { title, content } = parseTitleAndContent(docBody);
    return {
      type: "doc",
      title,
      prompt:
        content ||
        (title
          ? `请围绕“${title}”撰写一份结构完整、可直接使用的中文工作文档。`
          : ""),
    };
  }

  const proMatch = text.match(/^\/pro\b\s*/i);
  if (proMatch) {
    return {
      type: "chat",
      tier: "pro",
      prompt: text.slice(proMatch[0].length).trim(),
    };
  }
  return { type: "chat", tier: defaultTier, prompt: text };
}

function fitRecentMessages(messages, budget) {
  const selected = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = message.content.length + 24;
    if (selected.length && used + cost > budget) break;
    selected.push({ role: message.role, content: message.content });
    used += cost;
  }
  return selected.reverse();
}

function referenceMessage({ summary, memories, knowledge }) {
  const sections = [];
  if (summary) sections.push(`【此前会话摘要】\n${summary}`);
  if (memories.length) {
    sections.push(
      `【用户明确保存的长期记忆】\n${memories
        .map((item) => `- [${item.id}] ${item.content}`)
        .join("\n")}`,
    );
  }
  if (knowledge.length) {
    sections.push(
      `【相关知识库片段】\n${knowledge
        .map(
          (item) =>
            `- [知识 ${item.entry_id}：${item.title}] ${item.content}`,
        )
        .join("\n")}`,
    );
  }
  return sections.length
    ? {
        role: "system",
        content: `${sections.join("\n\n")}\n\n仅在与当前问题有关时使用这些参考内容。`,
      }
    : null;
}

export class ConversationService {
  constructor({ storage, deepseek, model, settings = {} }) {
    this.storage = storage;
    this.deepseek = deepseek;
    this.model = model;
    this.settings = {
      recentMessageLimit: 16,
      contextCharBudget: 24_000,
      summaryTriggerMessages: 24,
      summaryRetainMessages: 10,
      ...settings,
    };
  }

  messagesFor({ scopeId, ownerId, knowledgeScopeId, userText }) {
    const conversation = this.storage.getConversation(scopeId);
    const memories = ownerId
      ? this.storage.searchMemories(ownerId, userText, { limit: 5 })
      : [];
    const knowledge = this.storage.searchKnowledge(knowledgeScopeId, userText, {
      limit: 5,
    });
    const reference = referenceMessage({
      summary: conversation.summary,
      memories,
      knowledge,
    });
    const reserved =
      SYSTEM_PROMPT.length +
      userText.length +
      (reference?.content.length || 0) +
      500;
    const recent = this.storage.getRecentMessages(scopeId, {
      limit: this.settings.recentMessageLimit,
    });
    const fitted = fitRecentMessages(
      recent,
      Math.max(1_000, this.settings.contextCharBudget - reserved),
    );
    return [
      { role: "system", content: SYSTEM_PROMPT },
      ...(reference ? [reference] : []),
      ...fitted,
      { role: "user", content: userText },
    ];
  }

  addExchange(scopeId, userText, assistantText) {
    this.storage.addExchange(scopeId, userText, assistantText);
  }

  clear(scopeId) {
    this.storage.clearConversation(scopeId);
  }

  async compactIfNeeded(scopeId) {
    if (
      this.storage.countMessages(scopeId) <=
      this.settings.summaryTriggerMessages
    ) {
      return false;
    }
    const messages = this.storage.getMessagesForCompaction(scopeId, {
      retain: this.settings.summaryRetainMessages,
    });
    if (!messages.length) return false;

    const previous = this.storage.getConversation(scopeId).summary;
    const transcript = messages
      .map((message) =>
        `${message.role === "user" ? "用户" : "助手"}：${message.content}`,
      )
      .join("\n\n");
    const result = await this.deepseek.chat({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "请把会话压缩成可供后续对话使用的中文事实摘要。保留用户目标、约束、决定、重要事实和未完成事项；不要补充不存在的信息，控制在 1200 字以内。",
        },
        {
          role: "user",
          content: `${previous ? `已有摘要：\n${previous}\n\n` : ""}待压缩对话：\n${transcript}`,
        },
      ],
    });
    this.storage.compactConversation(
      scopeId,
      result.content,
      messages.at(-1).id,
    );
    return true;
  }
}

export function extractText(message) {
  const raw = message?.content;
  if (typeof raw !== "string") return "";
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text === "string") text = parsed.text;
  } catch {
    // Channel 的标准化消息可能已经是纯文本。
  }
  return text.replace(/@_user_\d+/g, "").trim();
}

export const HELP_TEXT = [
  "你好，我是 LinkFei。",
  "",
  "- 直接发送文字：结合持久会话、相关记忆和知识库回答",
  "- `/pro 你的问题`：使用 Pro 模型处理复杂任务",
  "- `/doc 标题 | 要求`：生成并创建飞书文档",
  "- `/new` 或 `/reset`：清除当前会话，不删除长期记忆",
  "- `/remember 内容`：保存一条个人长期记忆",
  "- `/memory`：查看个人长期记忆",
  "- `/forget 记忆编号` 或 `/forget all`：删除记忆",
  "- `/kb add 标题 | 内容`：添加当前私聊/群聊知识",
  "- `/kb list`、`/kb search 关键词`、`/kb delete 编号`：管理知识库",
  "- `/tasks`：查看最近文档任务",
  "- `/notify bind`：在私聊中绑定主动提醒收件人，并自动发送验收通知",
  "- `/notify test`：发送一条主动提醒测试",
  "- `/watch add 名称 | URL | 30m | CSS选择器（可选）`：监控页面更新",
  "- `/watch list`、`/watch check 编号`、`/watch pause/resume/delete 编号`：管理监控",
  "- `/help`：显示本帮助",
].join("\n");
