import {
  assertDeepSeekConfig,
  loadConfig,
} from "../src/config.mjs";
import { createDeepSeekClient } from "../src/deepseek.mjs";

const config = loadConfig();
assertDeepSeekConfig(config);

const client = createDeepSeekClient(config.deepseek);
const model = config.deepseek.models.flash;

console.log(`[linkfei] 正在验证 DeepSeek：${model}`);
const result = await client.chat({
  model,
  messages: [
    {
      role: "user",
      content: "这是连通性测试。请只回复：OK",
    },
  ],
});
console.log(`[linkfei] DeepSeek 返回：${result.content}`);
