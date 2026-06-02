"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clock3,
  FolderTree,
  LayoutDashboard,
  Languages,
  MessageSquareText,
  Network,
  Palette,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useLanguage } from "./i18n";
import { useTheme, type Theme } from "./theme";
import { cx } from "./ui";

type Action = {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
};

const THEME_CYCLE: Theme[] = ["default", "light", "dark"];

/**
 * Global Cmd/Ctrl+K command palette: jump between tabs and run quick actions.
 * Mounted once in the protected layout.
 */
export default function CommandPalette() {
  const router = useRouter();
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const tabs = t.sidebar.tabs;
  const actions = useMemo<Action[]>(() => {
    const go = (href: string) => () => {
      setOpen(false);
      router.push(href);
    };
    const navIcons: Record<string, LucideIcon> = {
      dashboard: LayoutDashboard,
      chat: MessageSquareText,
      explorer: FolderTree,
      graph: Network,
      automations: Clock3,
      settings: Settings,
    };
    const nav: Action[] = (
      ["dashboard", "chat", "explorer", "graph", "automations", "settings"] as const
    ).map((key) => ({
      id: `nav:${key}`,
      label: tabs[key].label,
      hint: tabs[key].desc,
      icon: navIcons[key],
      run: go(`/${key}`),
    }));
    nav.push({
      id: "theme",
      label: t.common.paletteThemeAction,
      hint: theme,
      icon: Palette,
      run: () => {
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
        setTheme(next);
      },
    });
    nav.push({
      id: "language",
      label: t.common.paletteLanguageAction,
      hint: language === "ko" ? "한국어 → English" : "English → 한국어",
      icon: Languages,
      run: () => {
        void setLanguage(language === "ko" ? "en" : "ko");
      },
    });
    return nav;
  }, [tabs, t, theme, language, router, setTheme, setLanguage]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [actions, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  function runAt(index: number) {
    filtered[index]?.run();
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-bg/70 p-4 pt-[12vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.common.commandPalette}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-line bg-bg-panel/95 shadow-[0_28px_70px_rgb(0_0_0_/_0.4)] backdrop-blur-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Search aria-hidden className="h-4 w-4 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) =>
                  filtered.length ? (i - 1 + filtered.length) % filtered.length : 0,
                );
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(activeIndex);
              }
            }}
            placeholder={t.common.commandPalettePlaceholder}
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <kbd className="shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
            ESC
          </kbd>
        </div>
        <ul className="max-h-80 overflow-auto p-1.5">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-ink-faint">
              {t.common.paletteNoResults}
            </li>
          ) : (
            filtered.map((action, i) => {
              const Icon = action.icon;
              return (
                <li key={action.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => runAt(i)}
                    className={cx(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left",
                      i === activeIndex ? "bg-bg" : "hover:bg-bg/60",
                    )}
                  >
                    <Icon aria-hidden className="h-4 w-4 shrink-0 text-ink-dim" />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {action.label}
                    </span>
                    {action.hint ? (
                      <span className="shrink-0 truncate font-mono text-[10px] text-ink-faint">
                        {action.hint}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
