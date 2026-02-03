"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark";

type ThemeCtx = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeCtx | null>(null);

function applyThemeToHtml(theme: Theme) {
  if (typeof document === "undefined") return;
  const el = document.documentElement; // <html>
  el.setAttribute("data-theme", theme);

  // opzionale ma utile: migliora UI browser (form, scrollbars)
  // (già gestito anche in CSS con color-scheme, ma qui è ok)
  (el.style as any).colorScheme = theme;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");

  // 1) inizializza dal localStorage o da preferenza sistema
  useEffect(() => {
    try {
      const saved = localStorage.getItem("scouthub.theme.v1") as Theme | null;
      if (saved === "light" || saved === "dark") {
        setThemeState(saved);
        applyThemeToHtml(saved);
        return;
      }
    } catch {}

    // fallback: preferenza sistema
    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;

    const initial: Theme = prefersDark ? "dark" : "light";
    setThemeState(initial);
    applyThemeToHtml(initial);
  }, []);

  // 2) ogni volta che cambia theme: salva e applica
  useEffect(() => {
    try {
      localStorage.setItem("scouthub.theme.v1", theme);
    } catch {}
    applyThemeToHtml(theme);
  }, [theme]);

  const api = useMemo<ThemeCtx>(() => {
    const setTheme = (t: Theme) => setThemeState(t);
    const toggleTheme = () => setThemeState((p) => (p === "dark" ? "light" : "dark"));
    return { theme, setTheme, toggleTheme };
  }, [theme]);

  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme deve essere usato dentro <Providers>");
  }
  return ctx;
}
