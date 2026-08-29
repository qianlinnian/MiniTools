const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const bootstrapSource = fs.readFileSync(
  path.join(__dirname, "..", "bootstrap.js"),
  "utf8"
);
assert.equal(bootstrapSource.includes("${rootURI}/"), false);
assert.ok(bootstrapSource.includes("${rootURI}content/preferences.xhtml"));

const toolkitSource = fs.readFileSync(
  path.join(__dirname, "..", "content", "readingToolkit.js"),
  "utf8"
);
for (const removedFeature of [
  "registerColumns",
  "reading-position",
  "browse-coverage",
  "effective-coverage",
  "reading-tracker-local.json",
  "清除阅读轨迹"
]) {
  assert.equal(toolkitSource.includes(removedFeature), false);
}

class MockItem {
  constructor(tags = [], options = {}) {
    this.tags = [...tags];
    this.id = options.id || 0;
    this.annotationColor = options.annotationColor || "";
    this.annotation = Boolean(options.annotation);
    this.saveCount = 0;
  }

  hasTag(name) {
    return this.tags.includes(name);
  }

  removeTag(name) {
    const oldLength = this.tags.length;
    this.tags = this.tags.filter(tag => tag !== name);
    return this.tags.length !== oldLength;
  }

  addTag(name) {
    if (this.hasTag(name)) {
      return false;
    }
    this.tags.push(name);
    return true;
  }

  getTags() {
    return this.tags.map(tag => ({ tag }));
  }

  isAnnotation() {
    return this.annotation;
  }

  async saveTx() {
    this.saveCount++;
  }
}

const prefs = new Map();
const context = {
  console,
  setTimeout,
  clearTimeout,
  Zotero: {
    Item: MockItem,
    Items: { get: () => null },
    Prefs: {
      get: key => prefs.get(key),
      set: (key, value) => prefs.set(key, value)
    },
    Reader: {
      registerEventListener: () => {},
      unregisterEventListener: () => {}
    },
    Notifier: {
      registerObserver: () => "observer-1",
      unregisterObserver: () => {}
    },
    logError: error => { throw error; },
    debug: () => {}
  }
};
vm.createContext(context);
for (const file of ["content/core.js", "content/readingToolkit.js"]) {
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
    context,
    { filename: file }
  );
}

const tracker = context.ReadingToolkit;

tracker.patchStatusTags();
const item = new MockItem(["未读", "在读", "topic"]);
assert.equal(item.addTag("在读"), true);
assert.deepEqual(item.tags, ["在读", "topic"]);
assert.equal(item.addTag("完成"), true);
assert.deepEqual(item.tags, ["topic", "完成"]);
tracker.restoreStatusTags();

(async () => {
  const annotation = new MockItem(
    ["标注类型/背景", "topic"],
    { id: 7, annotation: true, annotationColor: "#5fb236" }
  );
  assert.equal(await tracker.syncAnnotationTypeTag(annotation), true);
  assert.deepEqual(annotation.tags, ["topic", "标注类型/方法"]);
  assert.equal(annotation.saveCount, 1);
  assert.equal(await tracker.syncAnnotationTypeTag(annotation), false);
  assert.equal(annotation.saveCount, 1);

  prefs.set("extensions.readingtracker.annotationTypes.5fb236", "实验方法");
  assert.equal(await tracker.syncAnnotationTypeTag(annotation), true);
  assert.deepEqual(annotation.tags, ["topic", "标注类型/实验方法"]);

  console.log("integration tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
