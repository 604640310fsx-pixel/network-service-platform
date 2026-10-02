import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en } from "../i18n/en";
import { zh, type Messages } from "../i18n/zh";

/* 零依赖界面语言：中文（默认）/ English。
   初始语言 = localStorage `nsp.lang`，否则按浏览器语言（zh* → 中文，其余 → English）。
   切换后写回 localStorage，并同步 <html lang>。只翻译界面文案，不翻译服务端返回内容。 */

export type Lang = "zh" | "en";
export type { Messages };

export const LANG_STORAGE_KEY = "nsp.lang";
export const dictionaries: Readonly<Record<Lang, Messages>> = { zh, en };

export function resolveInitialLang(stored: string | null, navigatorLanguage: string | null | undefined): Lang {
  if (stored === "zh" || stored === "en") return stored;
  if (typeof navigatorLanguage !== "string" || navigatorLanguage === "") return "zh";
  return navigatorLanguage.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function htmlLangFor(lang: Lang): string {
  return lang === "zh" ? "zh-CN" : "en";
}

function readStoredLang(): string | null {
  try {
    return window.localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredLang(lang: Lang): void {
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // 存储不可用（隐私模式等）时只在本次会话内切换。
  }
}

function initialLang(): Lang {
  if (typeof window === "undefined") return "zh";
  return resolveInitialLang(readStoredLang(), window.navigator?.language);
}

type I18nValue = {
  readonly lang: Lang;
  readonly t: Messages;
  readonly setLang: (lang: Lang) => void;
};

// Provider 之外（例如单独渲染的组件测试）回落到中文、切换无效。
const I18nContext = createContext<I18nValue>({ lang: "zh", t: zh, setLang: () => undefined });

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => initial ?? initialLang());

  useEffect(() => {
    document.documentElement.lang = htmlLangFor(lang);
    // 标题与描述随语言切换；og:* 标签保持 index.html 静态值（爬虫不执行脚本）。
    const meta = dictionaries[lang].meta;
    document.title = meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", meta.description);
  }, [lang]);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      t: dictionaries[lang],
      setLang: (next: Lang) => {
        writeStoredLang(next);
        setLangState(next);
      },
    }),
    [lang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function useT(): Messages {
  return useContext(I18nContext).t;
}

/** 目录（subscribeCatalog）原文按当前语言显示：中文原样返回，其他语言查 `catalog` 译表，
    缺译时回落原文（测试保证目录里每个中文字符串都有译文）。 */
export function translateCatalogText(t: Messages, lang: Lang, text: string): string {
  return lang === "zh" ? text : (t.catalog[text] ?? text);
}

export function useCatalogText(): (text: string) => string {
  const { t, lang } = useContext(I18nContext);
  return (text: string) => translateCatalogText(t, lang, text);
}
