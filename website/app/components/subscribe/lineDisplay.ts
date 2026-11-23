import type { Lang } from "../../lib/i18n";

const directNames = new Set([
  "普通线路", "默认线路", "普通路线", "默认路线", "默认直连", "默认直连（高峰期不稳定）",
  "直连无优化（稳定性差）", "Direct, unoptimized (poor stability)",
  "基础直连（适合搭配前置中转）", "Basic direct (best with relay)",
  "Default direct (unstable at peak times)", "Default route", "Standard route",
]);
const optimizedNames = new Set([
  "半优化线路", "优化线路", "优化线路（高峰期稍慢）", "Optimized route (slower at peak times)",
  "回国优化线路（日常直连推荐）", "Optimized route (recommended for daily direct use)",
  "Optimized route", "Partially optimized route",
]);

/** Subscribe-only display text. The catalogue and selection continue to use their original names and IDs. */
export function subscriptionLineDisplay(text: string, lang: Lang, catalogText: (text: string) => string): string {
  const match = /^(.*?)( · (?:\d+G|\d+T))?$/.exec(text);
  const name = match?.[1] ?? text;
  const traffic = match?.[2] ?? "";
  if (directNames.has(name)) return `${lang === "zh" ? "默认直连" : "Default direct"}${traffic}`;
  if (optimizedNames.has(name)) return `${lang === "zh" ? "优化线路" : "Optimized route"}${traffic}`;
  return catalogText(text);
}

type LineTier = "direct" | "optimized" | "high" | "dedicated";
const tierById: Record<string, LineTier> = {
  direct: "direct", ordinary: "direct",
  half: "optimized", optimized: "optimized",
  high: "high", highspeed: "high",
  "three-net": "dedicated", live: "dedicated",
};
const tierByName: Record<string, LineTier> = {
  "高速线路": "high", "High-speed route": "high",
  "三网专线": "dedicated", "Triple-carrier route": "dedicated",
  "直播专线": "dedicated", "Live-streaming route": "dedicated",
};
const subtitles: Record<LineTier, { zh: string; en: string }> = {
  direct: { zh: "晚高峰易卡顿", en: "Prone to peak lag" },
  optimized: { zh: "日常轻度使用", en: "Light daily use" },
  high: { zh: "全天流畅推荐", en: "Smooth all day" },
  dedicated: { zh: "低延迟高稳定", en: "Low latency & steady" },
};

/** Muted one-line subtitle for a route card, by line ID or catalogue name; null for unknown lines. */
export function subscriptionLineSubtitle(lineIdOrName: string, lang: Lang): string | null {
  const name = lineIdOrName.replace(/ · (?:\d+G|\d+T)$/, "");
  const tier = tierById[name] ?? tierByName[name] ??
    (directNames.has(name) ? "direct" : optimizedNames.has(name) ? "optimized" : undefined);
  return tier ? subtitles[tier][lang] : null;
}
