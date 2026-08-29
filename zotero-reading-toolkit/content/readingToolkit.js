var ReadingToolkit = {
  originalAddTag: null,
  wrappedAddTag: null,
  readerHandlers: null,
  notifierID: null,
  syncingAnnotationIDs: new Set(),

  PREF_PREFIX: "extensions.readingtracker.annotationTypes.",

  async startup() {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise
    ]);
    this.patchStatusTags();
    this.registerSemanticAnnotations();
    Zotero.debug("Zotero Reading Toolkit: started");
  },

  async shutdown() {
    this.unregisterSemanticAnnotations();
    this.restoreStatusTags();
    Zotero.debug("Zotero Reading Toolkit: stopped");
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
