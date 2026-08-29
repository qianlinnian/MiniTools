import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import * as cheerio from "cheerio";

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

export function isPublicIp(address) {
  const family = isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family === 6) return !isPrivateIpv6(address);
  return false;
}

export async function validateMonitorUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("监控地址不是有效 URL。");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("监控地址只支持 http 或 https。");
  }
  if (url.username || url.password) {
    throw new Error("监控地址不能包含用户名或密码。");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("不能监控本机或局域网地址。");
  }
  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error("不能监控本机、局域网或保留 IP 地址。");
  } else {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
      throw new Error("监控地址解析到了本机、局域网或保留 IP。");
    }
  }
  return url;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r ]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readLimitedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`页面内容超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制。`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function extractContent(raw, contentType, selector) {
  if (!contentType.includes("html")) return normalizeText(raw);
  const $ = cheerio.load(raw);
  $("script, style, noscript, template, svg").remove();
  if (selector) {
    let selected;
    try {
      selected = $(selector);
    } catch {
      throw new Error(`CSS 选择器无效：${selector}`);
    }
    if (!selected.length) throw new Error(`页面中没有匹配 CSS 选择器：${selector}`);
    return normalizeText(selected.text());
  }
  return normalizeText($("body").text() || $.root().text());
}

export async function fetchPageSnapshot(
  rawUrl,
  {
    selector = null,
    timeoutMs = 30_000,
    maxBytes = 2 * 1024 * 1024,
    maxRedirects = 5,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  let currentUrl = await validateMonitorUrl(rawUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetchImpl(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": "LinkFei-Monitor/1.0",
        accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.1",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("页面重定向缺少 Location。");
      if (redirect === maxRedirects) throw new Error("页面重定向次数过多。");
      currentUrl = await validateMonitorUrl(new URL(location, currentUrl).href);
      continue;
    }
    if (!response.ok) throw new Error(`页面返回 HTTP ${response.status}。`);
    const raw = await readLimitedText(response, maxBytes);
    const content = extractContent(raw, response.headers.get("content-type") || "", selector);
    if (!content) throw new Error("页面监控区域没有可比较的文字内容。");
    return {
      finalUrl: currentUrl.href,
      content,
      hash: createHash("sha256").update(content).digest("hex"),
      excerpt: content.slice(0, 1_200),
    };
  }
  throw new Error("页面抓取失败。");
}
