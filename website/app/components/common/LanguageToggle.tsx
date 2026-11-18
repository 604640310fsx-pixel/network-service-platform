import { useI18n, type Lang } from "../../lib/i18n";
import "./language-toggle.css";

/* 中文 / EN 分段切换。每个按钮用 aria-pressed 表示当前语言；
   两个选项始终以各自语言显示，便于不懂当前语言的访客找到入口。 */

const OPTIONS: readonly Lang[] = ["zh", "en"];

export function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  return (
    <div className={`lang-toggle${className ? ` ${className}` : ""}`} role="group" aria-label={t.language.groupLabel}>
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          lang={option === "zh" ? "zh-CN" : "en"}
          aria-pressed={lang === option}
          aria-label={option === "zh" ? t.language.zhLabel : t.language.enLabel}
          className={lang === option ? "is-active" : undefined}
          onClick={() => setLang(option)}
        >
          {option === "zh" ? t.language.zh : t.language.en}
        </button>
      ))}
    </div>
  );
}
