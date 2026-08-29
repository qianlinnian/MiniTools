const LATIN_TOKEN = /[a-z0-9][a-z0-9_-]*/gi;
const HAN_SEQUENCE = /[\p{Script=Han}]+/gu;

export function tokenize(text) {
  const normalized = String(text || "").toLowerCase();
  const tokens = normalized.match(LATIN_TOKEN) || [];

  for (const sequence of normalized.match(HAN_SEQUENCE) || []) {
    if (sequence.length === 1) {
      tokens.push(sequence);
      continue;
    }
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.push(sequence.slice(index, index + 2));
    }
  }
  return tokens;
}

export function sparseVector(text) {
  const vector = new Map();
  for (const token of tokenize(text)) {
    vector.set(token, (vector.get(token) || 0) + 1);
  }
  return vector;
}

export function cosineSimilarity(leftText, rightText) {
  const left = sparseVector(leftText);
  const right = sparseVector(rightText);
  if (!left.size || !right.size) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  for (const [token, value] of left) {
    dot += value * (right.get(token) || 0);
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function rankByRelevance(items, query, { textOf, limit = 5 } = {}) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return [];

  return items
    .map((item) => {
      const text = String(textOf ? textOf(item) : item).toLowerCase();
      const exactBoost = text.includes(normalizedQuery) ? 0.35 : 0;
      return { item, score: cosineSimilarity(normalizedQuery, text) + exactBoost };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function splitKnowledgeContent(content, { maxChars = 900 } = {}) {
  const paragraphs = String(content || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  const chunks = [];
  let current = "";

  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += maxChars) {
        chunks.push(paragraph.slice(offset, offset + maxChars));
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks.length ? chunks : ["（空内容）"];
}
