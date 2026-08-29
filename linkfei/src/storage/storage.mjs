export class Storage {
  getConversation() {
    throw new Error("Storage.getConversation() 尚未实现。");
  }

  getRecentMessages() {
    throw new Error("Storage.getRecentMessages() 尚未实现。");
  }

  addExchange() {
    throw new Error("Storage.addExchange() 尚未实现。");
  }

  clearConversation() {
    throw new Error("Storage.clearConversation() 尚未实现。");
  }

  close() {}
}

export function assertStorage(storage) {
  const required = [
    "getConversation",
    "getRecentMessages",
    "addExchange",
    "clearConversation",
    "claimEvent",
    "completeEvent",
    "failEvent",
    "createDocumentTask",
    "updateDocumentTask",
    "addMemory",
    "listMemories",
    "deleteMemory",
    "addKnowledgeEntry",
    "searchKnowledge",
  ];

  for (const method of required) {
    if (typeof storage?.[method] !== "function") {
      throw new Error(`存储实现缺少 ${method}()。`);
    }
  }
  return storage;
}
