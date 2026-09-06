var ReadingToolkit = {
  originalAddTag: null,
  wrappedAddTag: null,
  readerHandlers: null,
  notifierID: null,
  syncingAnnotationIDs: new Set(),

  noteBusy: false,
  menuWindows: new Set(),

  PREF_PREFIX: "extensions.readingtracker.annotationTypes.",

  async startup() {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise
    ]);
    this.patchStatusTags();
    this.registerSemanticAnnotations();
    for (const win of Zotero.getMainWindows?.() || []) this.installNoteMenu(win);
    Zotero.debug("Zotero Reading Toolkit: started");
  },

  async shutdown() {
    for (const win of this.menuWindows) this.removeNoteMenu(win);
    this.unregisterSemanticAnnotations();
    this.restoreStatusTags();
    Zotero.debug("Zotero Reading Toolkit: stopped");
  },

  installNoteMenu(win) {
    const doc = win.document;
    const menu = doc.getElementById("menu_ToolsPopup");
    if (!menu || doc.getElementById("reading-toolkit-create-note")) return;
    const item = doc.createXULElement("menuitem");
    item.id = "reading-toolkit-create-note";
    item.setAttribute("label", "按语义汇总选中文献标注…");
    item.addEventListener("command", async () => {
      if (this.noteBusy) return;
      this.noteBusy = true;
      item.disabled = true;
      try {
        const count = await this.createReadingNotes(win.ZoteroPane.getSelectedItems());
        win.alert(count ? `已创建 ${count} 篇阅读笔记。` : "请选择带有 PDF 标注的文献或 PDF 附件。");
      } catch (error) { Zotero.logError(error); win.alert(`创建阅读笔记失败：${error.message}`); }
      finally { this.noteBusy = false; item.disabled = false; }
    });
    menu.appendChild(item);
    this.menuWindows.add(win);
  },

  removeNoteMenu(win) {
    win.document.getElementById("reading-toolkit-create-note")?.remove();
    this.menuWindows.delete(win);
  },

  async createReadingNotes(selected) {
    const parents = new Map();
    for (const item of selected) {
      const parent = item.isAttachment?.() && item.parentID ? Zotero.Items.get(item.parentID) : item;
      if (parent?.isRegularItem?.() || parent?.isPDFAttachment?.()) parents.set(parent.id, parent);
    }
    // Prepare all notes before a single transaction, preventing partially completed batches.
    const notes = [];
    for (const parent of parents.values()) {
      if (!Zotero.Libraries.get(parent.libraryID).editable) throw new Error("所选文献库为只读。");
      const attachments = parent.isPDFAttachment?.() ? [parent] : Zotero.Items.get(parent.getAttachments());
      const entries = [];
      for (const attachment of attachments) {
        if (!attachment.isPDFAttachment()) continue;
        const library = Zotero.Libraries.get(attachment.libraryID);
        const scope = library.libraryType === "group" ? `groups/${Zotero.Groups.getGroupIDFromLibraryID(attachment.libraryID)}` : "library";
        const annotations = [...attachment.getAnnotations()].sort((a,b) => String(a.annotationSortIndex).localeCompare(String(b.annotationSortIndex)));
        for (const annotation of annotations) {
          entries.push({
            label: this.getAnnotationType(annotation.annotationColor)?.label || "其他",
            text: annotation.annotationText || "", comment: annotation.annotationComment || "",
            page: annotation.annotationPageLabel || "?",
            url: `zotero://open-pdf/${scope}/items/${encodeURIComponent(attachment.key)}?annotation=${encodeURIComponent(annotation.key)}`
          });
        }
      }
      if (!entries.length) continue;
      const note = new Zotero.Item("note");
      note.libraryID = parent.libraryID;
      if (parent.isRegularItem?.()) note.parentID = parent.id;
      else if (parent.getCollections) note.setCollections(parent.getCollections());
      note.setNote(this.renderReadingNote(parent.getField("title"), entries));
      notes.push(note);
    }
    await Zotero.DB.executeTransaction(async () => { for (const note of notes) await note.save(); });
    return notes.length;
  },

  renderReadingNote(title, entries) {
    const escape = value => this.escapeHTML(value).replaceAll("\n", "<br/>");
    const groups = new Map(this.getAnnotationDefinitions().map(type => [type.label, []]));
    for (const entry of entries) {
      if (!groups.has(entry.label)) groups.set(entry.label, []);
      groups.get(entry.label).push(entry);
    }
    let html = `<h1>${escape(title)} · 阅读笔记</h1>`;
    for (const [label, annotations] of groups) {
      if (!annotations.length) continue;
      html += `<h2>${escape(label)}</h2>`;
      for (const annotation of annotations) {
        html += `<blockquote>${escape(annotation.text || "（图片或非文字标注，点击原文查看）")}</blockquote>`;
        if (annotation.comment) html += `<p>${escape(annotation.comment)}</p>`;
        html += `<p><a href="${this.escapeHTML(annotation.url)}">第 ${escape(annotation.page)} 页 · 返回标注</a></p>`;
      }
    }
    return html;
  },

  getPref(key, fallback) {
    const value = Zotero.Prefs.get(`${this.PREF_PREFIX}${key}`, true);
    return value === undefined || value === null ? fallback : value;
  },

  setPref(key, value) {
    Zotero.Prefs.set(`${this.PREF_PREFIX}${key}`, value, true);
  },

  getAnnotationDefinitions() {
    return ReadingTrackerCore.ANNOTATION_TYPES.map(definition => {
      const key = definition.color.slice(1).toLowerCase();
      const stored = String(this.getPref(key, definition.label)).trim();
      return { color: definition.color, label: stored || definition.label };
    });
  },

  getAnnotationType(color) {
    return ReadingTrackerCore.annotationTypeForColor(color, this.getAnnotationDefinitions());
  },

  initPreferences(doc) {
    const vertical = doc.getElementById("reading-toolkit-popup-vertical");
    if (vertical) {
      vertical.checked = Boolean(this.getPref("popupVertical", true));
      vertical.addEventListener("change", () => this.setPref("popupVertical", vertical.checked));
    }

    const autoTag = doc.getElementById("reading-toolkit-auto-tag");
    if (autoTag) {
      autoTag.checked = Boolean(this.getPref("autoTag", true));
      autoTag.addEventListener("change", () => this.setPref("autoTag", autoTag.checked));
    }

    const container = doc.getElementById("reading-toolkit-annotation-types");
    if (!container) {
      return;
    }

    for (const definition of ReadingTrackerCore.ANNOTATION_TYPES) {
      const prefKey = definition.color.slice(1).toLowerCase();
      const swatch = doc.createElement("span");
      swatch.style.cssText =
        `display:inline-block;width:20px;height:20px;border-radius:50%;background:${definition.color};` +
        "border:1px solid rgba(0,0,0,.15);flex-shrink:0;";
      swatch.title = definition.color;

      const input = doc.createElement("input");
      input.type = "text";
      input.value = String(this.getPref(prefKey, definition.label));
      input.placeholder = definition.label;
      input.style.cssText = "width:100%;box-sizing:border-box;";

      let timer = null;
      const save = () => {
        const value = input.value.trim() || definition.label;
        this.setPref(prefKey, value);
        input.value = value;
      };
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(save, 400);
      });
      input.addEventListener("blur", () => {
        clearTimeout(timer);
        save();
      });

      container.append(swatch, input);
    }
  },

  registerSemanticAnnotations() {
    if (this.readerHandlers) {
      return;
    }
    this.readerHandlers = {
      contextMenu: event => this.decorateColorContextMenu(event),
      selectionPopup: event => this.decorateSelectionPopup(event)
    };

    Zotero.Reader.registerEventListener("createAnnotationContextMenu", this.readerHandlers.contextMenu);
    Zotero.Reader.registerEventListener("createColorContextMenu", this.readerHandlers.contextMenu);
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", this.readerHandlers.selectionPopup);

    this.notifierID = Zotero.Notifier.registerObserver({
      notify: async (event, type, ids) => {
        if (type !== "item" || !["add", "modify"].includes(event)) {
          return;
        }
        for (const id of ids || []) {
          await this.syncAnnotationTypeTag(Zotero.Items.get(id));
        }
      }
    }, ["item"], "zotero-reading-toolkit");
  },

  unregisterSemanticAnnotations() {
    if (this.readerHandlers) {
      Zotero.Reader.unregisterEventListener("createAnnotationContextMenu", this.readerHandlers.contextMenu);
      Zotero.Reader.unregisterEventListener("createColorContextMenu", this.readerHandlers.contextMenu);
      Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this.readerHandlers.selectionPopup);
      this.readerHandlers = null;
    }
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    this.syncingAnnotationIDs.clear();
  },

  decorateColorContextMenu(event) {
    const reader = event?.reader;
    setTimeout(() => {
      try {
        const doc = reader?._iframeWindow?.document;
        if (!doc) {
          return;
        }
        for (const row of doc.querySelectorAll(".context-menu .row")) {
          if (row.dataset.readingToolkitType === "1") {
            continue;
          }
          const fill = row.querySelector("path[fill]")?.getAttribute("fill");
          const definition = this.getAnnotationType(fill);
          const svg = row.querySelector("svg");
          if (!definition || !svg) {
            continue;
          }
          row.innerHTML = `${svg.outerHTML}<span style="margin-left:6px">${this.escapeHTML(definition.label)}</span>`;
          row.dataset.readingToolkitType = "1";
          row.setAttribute("aria-label", definition.label);
          row.title = definition.label;
        }
      }
      catch (error) {
        Zotero.logError(error);
      }
    }, 10);
  },

  decorateSelectionPopup(event) {
    const reader = event?.reader;
    setTimeout(() => {
      try {
        const doc = reader?._iframeWindow?.document;
        const popup = doc?.querySelector(".selection-popup");
        if (!popup || popup.querySelector("[data-reading-toolkit-types='1']")) {
          return;
        }
        const buttons = [...popup.querySelectorAll(".toolbar-button.color-button")];
        if (!buttons.length) {
          return;
        }

        const vertical = Boolean(this.getPref("popupVertical", true));
        if (!vertical) {
          for (const button of buttons) {
            const fill = button.querySelector("path[fill]")?.getAttribute("fill");
            const definition = this.getAnnotationType(fill);
            if (definition) {
              button.title = definition.label;
              button.setAttribute("aria-label", definition.label);
            }
          }
          popup.dataset.readingToolkitTypes = "1";
          return;
        }

        const parent = buttons[0].parentElement;
        if (!parent) {
          return;
        }
        popup.style.width = "fit-content";
        popup.style.maxWidth = "600px";
        const container = doc.createElement("div");
        container.dataset.readingToolkitTypes = "1";
        container.style.cssText =
          "display:flex;flex-direction:row;align-items:flex-start;gap:4px;align-self:flex-start;";
        parent.insertBefore(container, buttons[0]);

        for (const button of buttons) {
          const fill = button.querySelector("path[fill]")?.getAttribute("fill");
          const definition = this.getAnnotationType(fill);
          const svg = button.querySelector("svg");
          container.appendChild(button);
          if (!definition || !svg) {
            continue;
          }
          button.replaceChildren(svg.cloneNode(true));
          const label = doc.createElement("span");
          label.textContent = definition.label;
          label.style.cssText =
            "margin-top:5px;font-size:.9em;line-height:1.15;white-space:nowrap;writing-mode:vertical-rl;text-orientation:upright;";
          button.appendChild(label);
          button.style.cssText +=
            "display:flex;flex-direction:column;align-items:center;justify-content:flex-start;width:38px;height:auto;min-height:96px;padding:5px 3px;box-sizing:border-box;";
          button.title = definition.label;
          button.setAttribute("aria-label", definition.label);
        }
      }
      catch (error) {
        Zotero.logError(error);
      }
    }, 10);
  },

  escapeHTML(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  },

  async syncAnnotationTypeTag(item) {
    if (!Boolean(this.getPref("autoTag", true)) || !item?.isAnnotation?.() || !item.id) {
      return false;
    }
    if (this.syncingAnnotationIDs.has(item.id)) {
      return false;
    }
    const definition = this.getAnnotationType(item.annotationColor);
    if (!definition) {
      return false;
    }

    const desiredTag = ReadingTrackerCore.annotationTag(definition.label);
    let changed = false;
    for (const tag of item.getTags?.() || []) {
      if (tag.tag.startsWith(ReadingTrackerCore.ANNOTATION_TAG_PREFIX) && tag.tag !== desiredTag) {
        changed = item.removeTag(tag.tag) || changed;
      }
    }
    if (desiredTag && !item.hasTag(desiredTag)) {
      changed = item.addTag(desiredTag) || changed;
    }
    if (!changed) {
      return false;
    }

    this.syncingAnnotationIDs.add(item.id);
    try {
      await item.saveTx();
    }
    finally {
      this.syncingAnnotationIDs.delete(item.id);
    }
    return true;
  },

  patchStatusTags() {
    if (this.originalAddTag) {
      return;
    }
    const statusTags = new Set(ReadingTrackerCore.STATUS_TAGS);
    this.originalAddTag = Zotero.Item.prototype.addTag;
    const original = this.originalAddTag;
    this.wrappedAddTag = function (name, type) {
      let removed = false;
      if (statusTags.has(name)) {
        for (const otherTag of statusTags) {
          if (otherTag !== name && this.hasTag(otherTag)) {
            removed = this.removeTag(otherTag) || removed;
          }
        }
      }
      return original.call(this, name, type) || removed;
    };
    Zotero.Item.prototype.addTag = this.wrappedAddTag;
  },

  restoreStatusTags() {
    if (this.originalAddTag && Zotero.Item.prototype.addTag === this.wrappedAddTag) {
      Zotero.Item.prototype.addTag = this.originalAddTag;
    }
    this.originalAddTag = null;
    this.wrappedAddTag = null;
  }
};
