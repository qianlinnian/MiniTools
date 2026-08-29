import { configSummary, loadConfig } from "../src/config.mjs";

console.log(JSON.stringify(configSummary(loadConfig()), null, 2));
