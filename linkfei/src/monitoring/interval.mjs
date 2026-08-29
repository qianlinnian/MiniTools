export function parseInterval(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|秒|分钟|小时|天)$/i);
  if (!match) return null;
  const units = { s: 1, 秒: 1, m: 60, 分钟: 60, h: 3_600, 小时: 3_600, d: 86_400, 天: 86_400 };
  const seconds = Math.round(Number(match[1]) * units[match[2].toLowerCase()]);
  return Number.isInteger(seconds) && seconds >= 60 && seconds <= 30 * 86_400
    ? seconds
    : null;
}

export function formatInterval(seconds) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
}
