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
  if (directNames.has(name)) return `${lang === "zh" ? "基础直连（适合搭配前置中转）" : "Basic direct (best with relay)"}${traffic}`;
  if (optimizedNames.has(name)) return `${lang === "zh" ? "回国优化线路（日常直连推荐）" : "Optimized route (recommended for daily direct use)"}${traffic}`;
  return catalogText(text);
}
