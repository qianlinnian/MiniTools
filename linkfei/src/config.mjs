import "dotenv/config";
import { resolve } from "node:path";

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value) {
  return (value || "https://api.deepseek.com").replace(/\/+$/, "");
}

export function loadConfig() {
  const defaultTier = (firstEnv("BOT_MODEL") || "flash").toLowerCase();

  return {
    deepseek: {
      apiKey: firstEnv("DEEPSEEK_API_KEY", "DEEPSEEK-KEY"),
      baseUrl: normalizeBaseUrl(
        firstEnv("DEEPSEEK_BASE_URL", "DEEPSEEK_URL", "DEEPSEEK-URL"),
      ),
      models: {
        flash:
          firstEnv("DEEPSEEK_MODEL_FLASH", "DEEPSEEK-MODEL-FLASH") ||
          "deepseek-v4-flash",
        pro:
          firstEnv("DEEPSEEK_MODEL_PRO", "DEEPSEEK-MODEL-PRO") ||
          "deepseek-v4-pro",
      },
      defaultTier: defaultTier === "pro" ? "pro" : "flash",
      timeoutMs: positiveInteger(
        firstEnv("DEEPSEEK_TIMEOUT_MS"),
        120_000,
      ),
    },
    feishu: {
      appId: firstEnv("FEISHU_APP_ID", "LARK_APP_ID", "APP_ID", "App_ID"),
      appSecret: firstEnv(
        "FEISHU_APP_SECRET",
        "LARK_APP_SECRET",
        "APP_SECRET",
      ),
      docBaseUrl: (
        firstEnv("FEISHU_DOC_BASE_URL") || "https://feishu.cn/docx"
      ).replace(/\/+$/, ""),
      loggerLevel: (firstEnv("FEISHU_LOG_LEVEL") || "info").toLowerCase(),
    },
    storage: {
      databasePath: resolve(
        firstEnv("LINKFEI_DB_PATH") || "data/linkfei.sqlite",
      ),
      recentMessageLimit: positiveInteger(
        firstEnv("LINKFEI_RECENT_MESSAGE_LIMIT"),
        16,
      ),
      contextCharBudget: positiveInteger(
        firstEnv("LINKFEI_CONTEXT_CHAR_BUDGET"),
        24_000,
      ),
      summaryTriggerMessages: positiveInteger(
        firstEnv("LINKFEI_SUMMARY_TRIGGER_MESSAGES"),
        24,
      ),
      summaryRetainMessages: positiveInteger(
        firstEnv("LINKFEI_SUMMARY_RETAIN_MESSAGES"),
        10,
      ),
    },
  };
}

export function assertDeepSeekConfig(config) {
  if (!config.deepseek.apiKey) {
    throw new Error(
      "缺少 DeepSeek API Key。请配置 DEEPSEEK_API_KEY（也兼容 DEEPSEEK-KEY）。",
    );
  }
}

export function assertFeishuConfig(config) {
  const missing = [];
  if (!config.feishu.appId) missing.push("FEISHU_APP_ID");
  if (!config.feishu.appSecret) missing.push("FEISHU_APP_SECRET");
  if (missing.length) {
    throw new Error(`缺少飞书配置：${missing.join("、")}`);
  }
}

export function configSummary(config) {
  return {
    deepseek: {
      apiKeyConfigured: Boolean(config.deepseek.apiKey),
      baseUrl: config.deepseek.baseUrl,
      models: config.deepseek.models,
      defaultTier: config.deepseek.defaultTier,
      timeoutMs: config.deepseek.timeoutMs,
    },
    feishu: {
      appIdConfigured: Boolean(config.feishu.appId),
      appSecretConfigured: Boolean(config.feishu.appSecret),
      docBaseUrl: config.feishu.docBaseUrl,
      loggerLevel: config.feishu.loggerLevel,
    },
    storage: config.storage,
  };
}
