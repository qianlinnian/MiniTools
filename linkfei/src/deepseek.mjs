function chatCompletionsUrl(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}

async function readError(response) {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || raw;
  } catch {
    return raw;
  }
}

export function createDeepSeekClient({
  apiKey,
  baseUrl,
  timeoutMs = 120_000,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) throw new Error("DeepSeek API Key 未配置。");
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node.js 运行时不支持 fetch，请使用 Node.js 20 或更高版本。");
  }

  return {
    async chat({ model, messages }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(chatCompletionsUrl(baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await readError(response);
          throw new Error(`DeepSeek API 请求失败（HTTP ${response.status}）：${detail}`);
        }

        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new Error("DeepSeek API 返回了空内容。");
        }

        return {
          content: content.trim(),
          usage: payload.usage,
          id: payload.id,
        };
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error(`DeepSeek API 请求超时（${timeoutMs}ms）。`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
