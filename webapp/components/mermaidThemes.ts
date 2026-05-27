"use client";

import { useEffect, useState } from "react";
import type { MermaidConfig } from "mermaid";

export type MermaidThemeId = "uml" | "default" | "neutral" | "dark" | "forest";

export const DEFAULT_MERMAID_THEME: MermaidThemeId = "uml";

export const MERMAID_THEME_OPTIONS: Array<{
  id: MermaidThemeId;
  label: string;
  title: string;
}> = [
  {
    id: "uml",
    label: "UML",
    title: "UML-style diagram theme",
  },
  {
    id: "default",
    label: "Default",
    title: "Mermaid default theme",
  },
  {
    id: "neutral",
    label: "Neutral",
    title: "Mermaid neutral theme",
  },
  {
    id: "dark",
    label: "Dark",
    title: "Mermaid dark theme",
  },
  {
    id: "forest",
    label: "Forest",
    title: "Mermaid forest theme",
  },
];

const STORAGE_KEY = "clio.mermaidTheme";
const THEME_EVENT = "clio:mermaid-theme-change";

export function getMermaidRenderConfig(theme: MermaidThemeId): MermaidConfig {
  if (theme !== "uml") {
    return { theme };
  }

  return {
    theme: "base",
    themeVariables: {
      background: "#ffffff",
      mainBkg: "#fffdf7",
      secondBkg: "#eef4ff",
      tertiaryColor: "#f8fafc",
      primaryColor: "#fffdf7",
      primaryTextColor: "#1f2937",
      primaryBorderColor: "#2f4f7f",
      secondaryColor: "#eef4ff",
      secondaryTextColor: "#1f2937",
      secondaryBorderColor: "#49627a",
      tertiaryTextColor: "#1f2937",
      tertiaryBorderColor: "#94a3b8",
      lineColor: "#334155",
      textColor: "#1f2937",
      fontFamily:
        '"Segoe UI", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif',
      fontSize: "15px",
      noteBkgColor: "#fff8dc",
      noteTextColor: "#1f2937",
      noteBorderColor: "#c9a227",
      actorBkg: "#fffdf7",
      actorBorder: "#2f4f7f",
      actorTextColor: "#1f2937",
      actorLineColor: "#334155",
      signalColor: "#334155",
      signalTextColor: "#1f2937",
      activationBkgColor: "#eef4ff",
      activationBorderColor: "#49627a",
      classText: "#1f2937",
      labelBoxBkgColor: "#ffffff",
      labelBoxBorderColor: "#94a3b8",
      labelTextColor: "#1f2937",
      edgeLabelBackground: "#ffffff",
      clusterBkg: "#f8fafc",
      clusterBorder: "#94a3b8",
    },
  };
}

export function readStoredMermaidTheme(): MermaidThemeId {
  if (typeof window === "undefined") return DEFAULT_MERMAID_THEME;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isMermaidThemeId(stored) ? stored : DEFAULT_MERMAID_THEME;
  } catch {
    return DEFAULT_MERMAID_THEME;
  }
}

export function writeStoredMermaidTheme(theme: MermaidThemeId) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Rendering should still work when browser storage is unavailable.
  }

  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

export function useMermaidTheme() {
  const [theme, setTheme] = useState<MermaidThemeId>(DEFAULT_MERMAID_THEME);

  useEffect(() => {
    function syncFromStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY) return;
      setTheme(readStoredMermaidTheme());
    }

    function syncFromLocalChange(event: Event) {
      const next =
        event instanceof CustomEvent && isMermaidThemeId(event.detail)
          ? event.detail
          : readStoredMermaidTheme();
      setTheme(next);
    }

    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(THEME_EVENT, syncFromLocalChange);
    setTheme(readStoredMermaidTheme());

    return () => {
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(THEME_EVENT, syncFromLocalChange);
    };
  }, []);

  function updateTheme(next: MermaidThemeId) {
    setTheme(next);
    writeStoredMermaidTheme(next);
  }

  return [theme, updateTheme] as const;
}

function isMermaidThemeId(value: unknown): value is MermaidThemeId {
  return MERMAID_THEME_OPTIONS.some((option) => option.id === value);
}
