"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AutoLintBadge from "./AutoLintBadge";
import { BRAND_NAME, type Language, useLanguage } from "./i18n";

type Tab = {
  href: string;
  key: "chat" | "explorer" | "graph" | "settings";
  icon: string;
};

const TABS: Tab[] = [
  { href: "/chat", key: "chat", icon: "💬" },
  { href: "/explorer", key: "explorer", icon: "📁" },
  { href: "/graph", key: "graph", icon: "🕸" },
  { href: "/settings", key: "settings", icon: "⚙" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { language, setLanguage, savingLanguage, t } = useLanguage();
  const [loggingOut, setLoggingOut] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem("lw-sidebar-collapsed") === "1");
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("lw-sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  }

  async function onLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  async function onLanguage(nextLanguage: Language) {
    try {
      await setLanguage(nextLanguage);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <aside
      className={[
        "flex h-screen shrink-0 flex-col border-r border-line bg-bg-subtle transition-[width]",
        collapsed ? "w-16" : "w-56",
      ].join(" ")}
    >
      <div className={collapsed ? "px-2 pb-3 pt-6" : "px-5 pb-3 pt-6"}>
        <div className="flex items-start justify-between gap-2">
          <div className={collapsed ? "sr-only" : ""}>
            <div className="font-mono text-xs uppercase tracking-widest text-ink-faint">
              {BRAND_NAME}
            </div>
            <div className="mt-1 text-sm text-ink-dim">{t.sidebar.local}</div>
          </div>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? t.sidebar.expand : t.sidebar.collapse}
            title={collapsed ? t.sidebar.expand : t.sidebar.collapse}
            className={[
              "flex h-8 w-8 items-center justify-center rounded border border-line text-sm text-ink-dim hover:bg-bg-panel hover:text-ink",
              collapsed ? "mx-auto" : "",
            ].join(" ")}
          >
            {collapsed ? "›" : "‹"}
          </button>
        </div>
      </div>

      <nav className="flex flex-col gap-1 px-2 pt-2">
        {TABS.map((tab) => {
          const active =
            pathname === tab.href || pathname?.startsWith(`${tab.href}/`);
          const tabText = t.sidebar.tabs[tab.key];
          return (
            <Link
              key={tab.href}
              href={tab.href}
              title={collapsed ? tabText.label : undefined}
              className={[
                "group relative flex rounded-md transition-colors",
                collapsed
                  ? "h-10 items-center justify-center px-0 py-0"
                  : "flex-col px-3 py-2",
                active
                  ? "bg-bg-panel text-ink"
                  : "text-ink-dim hover:bg-bg-panel/60 hover:text-ink",
              ].join(" ")}
            >
              {tab.key === "settings" ? (
                <AutoLintBadge className="absolute right-1.5 top-1.5" />
              ) : null}
              <span className="flex items-center gap-2 text-sm">
                <span aria-hidden className="text-base leading-none">
                  {tab.icon}
                </span>
                <span className={collapsed ? "sr-only" : "font-medium"}>
                  {tabText.label}
                </span>
              </span>
              {collapsed ? null : (
                <span
                  className={[
                    "ml-7 text-[11px] leading-tight transition-colors",
                    active ? "text-ink-dim" : "text-ink-faint",
                  ].join(" ")}
                >
                  {tabText.desc}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div
        className={[
          "mt-auto flex flex-col gap-2 pb-5 pt-3",
          collapsed ? "px-2" : "px-5",
        ].join(" ")}
      >
        <div
          className={[
            "rounded-md border border-line bg-bg/50 p-1",
            collapsed ? "flex flex-col gap-1" : "",
          ].join(" ")}
          aria-label={t.common.language}
          title={collapsed ? t.common.language : undefined}
        >
          {collapsed ? null : (
            <div className="px-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              {t.common.language}
              {savingLanguage ? ` · ${t.sidebar.languageSaving}` : ""}
            </div>
          )}
          <div className={collapsed ? "flex flex-col gap-1" : "grid grid-cols-2 gap-1"}>
            {(["ko", "en"] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => void onLanguage(code)}
                disabled={savingLanguage}
                className={[
                  "h-7 rounded text-[11px] font-medium transition-colors disabled:opacity-50",
                  language === code
                    ? "bg-accent text-bg"
                    : "text-ink-dim hover:bg-bg-panel hover:text-ink",
                ].join(" ")}
                aria-pressed={language === code}
                title={code === "ko" ? t.common.korean : t.common.english}
              >
                {code.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          disabled={loggingOut}
          title={collapsed ? t.sidebar.logout : undefined}
          className={[
            "rounded-md border border-line bg-bg/60 px-3 py-2 text-xs text-ink-dim hover:bg-bg-panel hover:text-ink disabled:opacity-50",
            collapsed ? "px-0" : "",
          ].join(" ")}
        >
          {collapsed ? "⎋" : loggingOut ? t.sidebar.loggingOut : t.sidebar.logout}
        </button>
        {collapsed ? null : (
          <div className="rounded-md border border-line bg-bg/40 px-3 py-2 text-[11px] leading-snug text-ink-faint">
            {t.sidebar.localOnlyPrefix}{" "}
            <span className="text-ink-dim">
              {t.sidebar.localOnlyEmphasis}
            </span>
            {t.sidebar.localOnlySuffix}
            <br />
            {t.sidebar.defaultBind}: <span className="font-mono">0.0.0.0</span>
          </div>
        )}
      </div>
    </aside>
  );
}
