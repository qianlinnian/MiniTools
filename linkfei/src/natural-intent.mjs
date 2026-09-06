function normalizedText(text) {
  return String(text || "")
    .trim()
    .replace(/[？?。！!]+$/g, "")
    .replace(/[ \t]+/g, " ");
}

function guidance(message) {
  return { type: "guidance", message };
}

function parseTitleAndContent(body) {
  const [title = "", ...content] = body.split("|").map((item) => item.trim());
  return { title, content: content.join(" | ").trim() };
}

function extractDocumentTitle(text) {
  const labeled = text.match(
    /(?:标题|文档名|文档名称|名称)\s*(?:是|为|叫|叫做|：|:)\s*[《「“\"]?([^，,。；;\n|》」”\"]+)/i,
  );
  if (labeled?.[1]) return labeled[1].trim();

  const quoted = text.match(/(?:文档)?\s*[《「“\"]([^》」”\"]+)[》」”\"]/);
  if (quoted?.[1]) return quoted[1].trim();

  const topic = text.match(
    /(?:关于|主题(?:是|为)|围绕)\s*[《「“\"]?([^，,。；;\n|》」”\"]+)/,
  );
  if (topic?.[1]) return topic[1].trim();

  const trailing = text.match(
    /(?:创建|新建|生成|撰写)(?:一份|一个)?(?:新的)?(?:飞书)?(?:云)?文档\s*[，,：:\s]+([^，,。；;\n|]+)/,
  );
  return trailing?.[1]?.trim() || "";
}

function routeHelp(text) {
  const lower = text.toLowerCase();
  const patterns = [
    /^(?:(?:你|linkfei)(?:都)?)?(?:有|支持)(?:哪些|什么)(?:斜杠)?(?:指令|命令)$/,
    /^(?:你|linkfei)?(?:的)?(?:指令|命令)(?:列表|清单)$/,
    /^(?:怎么|如何)(?:使用|用)(?:你|linkfei)?$/,
    /^(?:你|linkfei)(?:都)?能(?:做|干)什么$/,
    /^(?:你|linkfei)(?:有|支持)什么功能$/,
    /^(?:我的意思是 *)?(?:类似于 *)?\/doc *(?:这样(?:子)?的?)?(?:斜杠)?(?:指令|命令)$/,
  ];
  return patterns.some((pattern) => pattern.test(lower))
    ? { type: "help" }
    : null;
}

function routeDocument(text) {
  const target = /(?:飞书(?:云)?文档|写到飞书|写进飞书|放到飞书)/.test(text);
  const action = /(?:创建|新建|生成|撰写|写|整理|保存)/.test(text);
  const hypothetical = /(?:如果|假如|是否|能不能|可不可以|怎么|如何).{0,12}(?:创建|新建|生成|写)/.test(text);
  if (!target || !action || hypothetical) return null;

  const title = extractDocumentTitle(text);
  if (!title) {
    return guidance(
      "我可以直接创建飞书文档，但还需要文档标题。请例如发送：`创建飞书文档，标题是项目周报，内容包括本周进展和风险`。",
    );
  }
  return {
    type: "doc",
    title,
    prompt: `请根据以下用户原始要求撰写文档：\n\n${text}`,
  };
}

function routePro(text) {
  const match = text.match(
    /^(?:请)?(?:使用|用)\s*(?:deepseek\s*)?(?:pro|专业|深度)\s*(?:模型|模式)?\s*(?:来)?(?:回答|处理|分析|思考)?\s*[：:，, ]*(.+)$/is,
  );
  return match?.[1]
    ? { type: "chat", tier: "pro", prompt: match[1].trim() }
    : null;
}

function routeConversation(text) {
  if (/^(?:请)?(?:清空|重置|清除)(?:一下)?(?:当前)?(?:会话|聊天|上下文)$/.test(text)) {
    return { type: "reset" };
  }
  if (/^(?:请)?(?:开始|新建|开启)(?:一个|一段)?新(?:会话|聊天)$/.test(text)) {
    return { type: "new" };
  }
  return null;
}

function routeMemory(text) {
  if (/^(?:请)?(?:查看|列出|显示)(?:一下)?(?:我的)?(?:长期)?记忆$/.test(text)) {
    return { type: "memory" };
  }
  const remember = text.match(
    /^(?:请)?(?:长期)?记住(?:这个|这件事|以下内容)?\s*[：:，, ]*(?!了[吗么]?)(.+)$/s,
  );
  if (remember?.[1]) return { type: "remember", content: remember[1].trim() };
  if (/(?:忘记|删除|清除).*(?:长期)?记忆|(?:长期)?记忆.*(?:忘记|删除|清除)/.test(text)) {
    return guidance(
      "删除长期记忆需要明确编号，请先发送“查看我的长期记忆”，确认后使用 `/forget 编号`；删除全部使用 `/forget all`。",
    );
  }
  return null;
}

function routeKnowledge(text) {
  if (/^(?:请)?(?:查看|列出|显示)(?:一下)?(?:当前)?知识库(?:内容|条目)?$/.test(text)) {
    return { type: "knowledge", action: "list" };
  }
  const search = text.match(
    /^(?:请)?(?:在)?知识库(?:中|里)?(?:搜索|查找|检索)\s*[：:，, ]*(.+)$/s,
  );
  if (search?.[1]) {
    return { type: "knowledge", action: "search", value: search[1].trim() };
  }
  const structured = text.match(
    /^(?:请)?(?:向|在)?知识库(?:中|里)?(?:添加|新增|保存)\s*[：:，, ]+(.+)$/s,
  );
  if (structured?.[1]) {
    const { title, content } = parseTitleAndContent(structured[1]);
    if (title && content) return { type: "knowledge", action: "add", title, content };
    return guidance("添加知识需要标题和正文，请例如发送：`知识库添加：发布流程 | 先灰度再全量`。");
  }
  const conversationalAdd = text.match(
    /^(?:请)?(?:把|将)\s*(.+?)\s*(?:加入|添加到|保存到)(?:当前|我的)?知识库(?:[，,]\s*(?:标题|名称)\s*(?:是|为|：|:)\s*(.+))?$/s,
  );
  if (conversationalAdd?.[1]) {
    const content = conversationalAdd[1].replace(/^[“\"]|[”\"]$/g, "").trim();
    const title = conversationalAdd[2]?.trim() || content.slice(0, 30);
    return { type: "knowledge", action: "add", title, content };
  }
  if (/(?:删除|移除).*(?:知识库|知识)|(?:知识库|知识).*(?:删除|移除)/.test(text)) {
    return guidance(
      "删除知识库条目需要明确编号，请先发送“查看知识库”，确认后使用 `/kb delete 编号`。",
    );
  }
  return null;
}

function routeTasks(text) {
  return /^(?:请)?(?:查看|列出|显示)(?:一下)?(?:最近|当前)?(?:的)?(?:文档)?任务(?:列表|状态)?$/.test(text)
    ? { type: "tasks" }
    : null;
}

function routeNotification(text) {
  if (/^(?:请)?(?:绑定|设置)(?:当前私聊|这里)?(?:为|成)?(?:默认)?(?:主动)?(?:提醒|通知)(?:的)?收件人$/.test(text)) {
    return { type: "notify", action: "bind", value: "" };
  }
  if (/^(?:请)?(?:给我)?(?:发送|发)(?:一条|一个)?(?:飞书)?(?:主动)?(?:提醒|通知)(?:的)?测试$/.test(text)) {
    return { type: "notify", action: "test", value: "" };
  }
  if (/^(?:请)?(?:查看|检查)(?:一下)?(?:主动)?(?:提醒|通知)(?:的)?(?:状态|发送状态)$/.test(text)) {
    return { type: "notify", action: "status", value: "" };
  }
  return null;
}

function normalizeInterval(value) {
  const match = value?.match(/(\d+)\s*(分钟|小时|天|m|h|d)/i);
  if (!match) return "30m";
  const units = { 分钟: "m", 小时: "h", 天: "d" };
  return `${match[1]}${units[match[2]] || match[2].toLowerCase()}`;
}

function routeWatch(text) {
  if (/(?:删除|移除).*(?:网页)?监控|(?:网页)?监控.*(?:删除|移除)/.test(text)) {
    return guidance(
      "删除网页监控不可恢复。请先发送“查看网页监控”，确认编号后使用 `/watch delete 编号`。",
    );
  }
  if (/^(?:请)?(?:查看|列出|显示)(?:一下)?(?:所有)?(?:网页|页面)?监控(?:列表|状态)?$/.test(text)) {
    return { type: "watch", action: "list", value: "" };
  }
  const control = text.match(
    /^(?:请)?(?:立即)?(检查|暂停|恢复)(?:一下)?(?:网页|页面)?监控\s*#?(\d+)$/,
  );
  if (control) {
    const actions = { 检查: "check", 暂停: "pause", 恢复: "resume" };
    return { type: "watch", action: actions[control[1]], value: control[2] };
  }
  if (!/(?:监控|持续检查|定期检查)/.test(text)) return null;
  const urlMatch = text.match(/https?:\/\/[^\s，,。；;]+/i);
  if (!urlMatch) return null;
  const url = urlMatch[0];
  const explicitName = text.match(/(?:名称|名字)\s*(?:是|为|：|:)\s*([^，,。；;\n]+)/)?.[1]?.trim();
  let name = explicitName;
  if (!name) {
    try {
      name = `${new URL(url).hostname} 页面`;
    } catch {
      name = "网页更新";
    }
  }
  const selector = text.match(/(?:CSS)?选择器\s*(?:是|为|：|:)\s*([^，,。；;\n]+)/i)?.[1]?.trim() || "";
  return {
    type: "watch",
    action: "add",
    name,
    url,
    interval: normalizeInterval(text),
    selector,
  };
}

const ROUTERS = [
  routeHelp,
  routeDocument,
  routePro,
  routeConversation,
  routeMemory,
  routeKnowledge,
  routeTasks,
  routeNotification,
  routeWatch,
];

export function routeNaturalLanguageIntent(input) {
  const text = normalizedText(input);
  if (!text || text.startsWith("/")) return null;
  for (const route of ROUTERS) {
    const result = route(text);
    if (result) return result;
  }
  return null;
}
