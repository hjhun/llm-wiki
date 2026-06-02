"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clock3,
  FileText,
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

type Group = "action" | "wiki";

type Item = {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  group: Group;
  run: () => void;
};

type WikiHit = { path: string; title: string; snippet: string };

const THEME_CYCLE: Theme[] = ["default", "light", "dark"];

/**
 * Global Cmd/Ctrl+K command palette: jump between tabs, run quick actions, and
 * search wiki pages. Mounted once in the protected layout.
 */
export default function CommandPalette() {
  const router = useRouter();
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [hits, setHits] = useState<WikiHit[]>([]);
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
      setHits([]);
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced wiki search.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!res.ok) throw new Error();
          const json = (await res.json()) as { hits?: WikiHit[] };
          setHits(json.hits ?? []);
        } catch {
          /* aborted or failed: leave previous hits */
        }
      })();
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const tabs = t.sidebar.tabs;
  const actionItems = useMemo<Item[]>(() => {
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
    const nav: Item[] = (
      ["dashboard", "chat", "explorer", "graph", "automations", "settings"] as const
    ).map((key) => ({
      id: `nav:${key}`,
      label: tabs[key].label,
      hint: tabs[key].desc,
      icon: navIcons[key],
      group: "action",
      run: go(`/${key}`),
    }));
    nav.push({
      id: "theme",
      label: t.common.paletteThemeAction,
      hint: theme,
      icon: Palette,
      group: "action",
      run: () =>
        setTheme(
          THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length],
        ),
    });
    nav.push({
      id: "language",
      label: t.common.paletteLanguageAction,
      hint: language === "ko" ? "한국어 → English" : "English → 한국어",
      icon: Languages,
      group: "action",
      run: () => void setLanguage(language === "ko" ? "en" : "ko"),
    });
    const q = query.trim().toLowerCase();
    if (!q) return nav;
    return nav.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [tabs, t, theme, language, query, router, setTheme, setLanguage]);

  const wikiItems = useMemo<Item[]>(
    () =>
      hits.map((hit) => ({
        id: `wiki:${hit.path}`,
        label: hit.title,
        hint: hit.snippet,
        icon: FileText,
        group: "wiki",
        run: () => {
          setOpen(false);
          router.push(`/explorer?ws=wiki&path=${encodeURIComponent(hit.path)}`);
        },
      })),
    [hits, router],
  );

  const items = useMemo(
    () => [...actionItems, ...wikiItems],
    [actionItems, wikiItems],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query, hits]);

  if (!open) return null;

  function runAt(index: number) {
    items[index]?.run();
  }

  const firstWikiIndex = actionItems.length;

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
                setActiveIndex((i) => (items.length ? (i + 1) % items.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) =>
                  items.length ? (i - 1 + items.length) % items.length : 0,
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
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-ink-faint">
              {t.common.paletteNoResults}
            </li>
          ) : (
            items.map((item, i) => {
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  {i === firstWikiIndex && wikiItems.length > 0 ? (
                    <div className="mb-1 mt-2 px-2.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                      {t.common.paletteWikiResults}
                    </div>
                  ) : null}
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
                      {item.label}
                    </span>
                    {item.hint ? (
                      <span className="max-w-[45%] shrink-0 truncate font-mono text-[10px] text-ink-faint">
                        {item.hint}
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
