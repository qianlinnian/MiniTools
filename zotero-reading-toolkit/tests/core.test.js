const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "content", "core.js"), "utf8");
const context = {};
vm.createContext(context);
vm.runInContext(source, context);
const core = context.ReadingTrackerCore;

assert.equal(core.annotationTypeForColor("#5FB236").label, "方法");
assert.equal(core.annotationTypeForColor(" #2ea8e5 ").label, "结论");
assert.equal(core.annotationTypeForColor("#000000"), null);
assert.equal(core.annotationTag("创新"), "标注类型/创新");
assert.equal(core.annotationTag("  "), "");

assert.deepEqual(
  JSON.parse(JSON.stringify(core.STATUS_TAGS)),
  ["未读", "在读", "完成"]
);

console.log("core tests passed");
