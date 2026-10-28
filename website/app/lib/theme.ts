import { useEffect, useState } from "react";

/* 客户中心深浅主题偏好。
   从 CustomerCenterShell 抽出，供客户中心与登录页共用同一存储键与同一行为，
   行为与抽出前完全一致。 */

export type ThemePreference = "dark" | "light";

const themeStorageKey = "nsp.customer-center.theme";

function initialTheme(): ThemePreference {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(themeStorageKey);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function useThemePreference() {
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);

  useEffect(() => {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (stored === "dark" || stored === "light") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const sync = (event: MediaQueryListEvent) => setTheme(event.matches ? "light" : "dark");
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    window.localStorage.setItem(themeStorageKey, next);
    setTheme(next);
  }

  return { theme, toggleTheme };
}
