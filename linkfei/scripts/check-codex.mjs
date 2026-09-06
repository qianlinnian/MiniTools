import { CodexClient } from "../src/codex/client.mjs";
const client = new CodexClient();
try {
  await client.start();
  const { account } = await client.request("account/read", { refreshToken: false });
  const models = await client.request("model/list", {});
  console.log(JSON.stringify({ authenticated: Boolean(account), authType: account?.type,
    models: models.data.map(model => ({ model: model.model, isDefault: model.isDefault })) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); }
