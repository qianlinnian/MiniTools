var ReadingTrackerCore = {
  STATUS_TAGS: ["未读", "在读", "完成"],
  ANNOTATION_TAG_PREFIX: "标注类型/",
  ANNOTATION_TYPES: [
    { color: "#ffd400", label: "背景" },
    { color: "#ff6666", label: "质疑/重要" },
    { color: "#5fb236", label: "方法" },
    { color: "#2ea8e5", label: "结论" },
    { color: "#a28ae5", label: "创新" },
    { color: "#e56eee", label: "不足" },
    { color: "#f19837", label: "待办" },
    { color: "#aaaaaa", label: "引用/旁支" }
  ],

  normalizeColor(color) {
    return String(color || "").trim().toLowerCase();
  },

  annotationTypeForColor(color, definitions = this.ANNOTATION_TYPES) {
    const normalized = this.normalizeColor(color);
    return definitions.find(definition => this.normalizeColor(definition.color) === normalized) || null;
  },

  annotationTag(label) {
    const normalized = String(label || "").trim();
    return normalized ? `${this.ANNOTATION_TAG_PREFIX}${normalized}` : "";
  }
};
