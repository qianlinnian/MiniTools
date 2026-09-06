const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");
const saved = [];
const annotation = { annotationColor: "#5fb236", annotationText: "<script>bad</script>", annotationComment: "A&B", annotationPageLabel: "2", annotationSortIndex: "001", key: "ANN" };
const pdf = { id: 2, parentID: 1, key: "PDF", libraryID: 1, isAttachment: () => true, isPDFAttachment: () => true, getAnnotations: () => [annotation] };
const parent = { id: 1, libraryID: 1, isRegularItem: () => true, getAttachments: () => [2], getField: () => "Title" };
let editable = true;
const context = { Zotero: {
  Prefs: { get: () => undefined },
  Items: { get: id => Array.isArray(id) ? id.map(n => n === 2 ? pdf : parent) : parent },
  Libraries: { get: () => ({ editable, libraryType: "group" }) },
  Groups: { getGroupIDFromLibraryID: () => 42 },
  DB: { executeTransaction: async fn => fn() },
  Item: class { setNote(html) { this.html = html; } async save() { saved.push(this); } }
}};
vm.createContext(context);
for (const name of ["core.js", "readingToolkit.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname,"../content",name),"utf8"),context);
(async () => {
  const toolkit = context.ReadingToolkit;
  assert.equal(await toolkit.createReadingNotes([parent,pdf]), 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].parentID, 1);
  assert.match(saved[0].html, /<h2>方法<\/h2>/);
  assert.match(saved[0].html, /&lt;script&gt;/);
  assert.doesNotMatch(saved[0].html, /<script>/);
  assert.match(saved[0].html, /A&amp;B/);
  assert.match(saved[0].html, /groups\/42\/items\/PDF\?annotation=ANN/);
  editable = false;
  await assert.rejects(() => toolkit.createReadingNotes([parent]), /只读/);
  assert.equal(saved.length, 1);
  assert.equal(await toolkit.createReadingNotes([]), 0);
  console.log("reading note tests passed");
})().catch(error => { console.error(error); process.exitCode=1; });
