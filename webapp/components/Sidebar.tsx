"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  FolderTree,
  Languages,
  LayoutDashboard,
  LogOut,
  MessageSquareText,
  Settings,
} from "lucide-react";
import { useEffect, useState } from "react";
import packageJson from "../package.json";
import AutoLintBadge from "./AutoLintBadge";
import { BRAND_NAME } from "@/lib/branding";
import { LANGUAGE_OPTIONS } from "@/lib/i18n";
import { type Language, useLanguage } from "./i18n";
import { IconButton, cx } from "./ui";
import type { LucideIcon } from "lucide-react";

type Tab = {
  href: string;
  key: "dashboard" | "chat" | "explorer" | "automations" | "settings";
  icon: LucideIcon;
};

const TABS: Tab[] = [
  { href: "/dashboard", key: "dashboard", icon: LayoutDashboard },
  { href: "/chat", key: "chat", icon: MessageSquareText },
  { href: "/explorer", key: "explorer", icon: FolderTree },
  { href: "/automations", key: "automations", icon: Clock3 },
  { href: "/settings", key: "settings", icon: Settings },
];

export default function Sidebar({
  appSubtitle,
}: {
  appSubtitle?: string;
}) {
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
      className={cx(
        "flex h-screen shrink-0 flex-col border-r border-line bg-bg-panel/72 shadow-[16px_0_42px_rgb(0_0_0_/_0.18)] backdrop-blur-xl transition-[width]",
        collapsed ? "w-[4.25rem]" : "w-60",
      )}
    >
      <div className={collapsed ? "px-2 pb-3 pt-6" : "px-5 pb-3 pt-6"}>
        <div className={cx("relative", collapsed ? "flex justify-center" : "")}>
          <div className={cx("min-w-0", collapsed ? "sr-only" : "mx-auto")}>
            <div className="flex flex-col items-center gap-1.5">
              <span className="inline-flex rounded-md border border-line/70 bg-[#f7f3e8] px-2.5 py-2 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.7)]">
                <img
                  src="/clio-logo.svg"
                  alt={BRAND_NAME}
                  className="h-16 w-auto"
                />
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-dim">
                v{packageJson.version}
              </span>
            </div>
            {appSubtitle ? (
              <div className="mt-2 truncate text-xs font-medium text-ink-dim">
                {appSubtitle}
              </div>
            ) : null}
          </div>
          <IconButton
            onClick={toggleCollapsed}
            label={collapsed ? t.sidebar.expand : t.sidebar.collapse}
            icon={collapsed ? ChevronRight : ChevronLeft}
            className={collapsed ? "mx-auto" : "absolute right-0 top-0"}
          />
        </div>
      </div>

      <nav className="flex flex-col gap-1.5 px-2 pt-2">
        {TABS.map((tab) => {
          const active =
            pathname === tab.href || pathname?.startsWith(`${tab.href}/`);
          const tabText = t.sidebar.tabs[tab.key];
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              title={collapsed ? tabText.label : undefined}
              className={cx(
                "group relative flex rounded-md border transition-colors",
                collapsed
                  ? "h-10 items-center justify-center px-0 py-0"
                  : "flex-col px-3 py-2.5",
                active
                  ? "border-accent/45 bg-[linear-gradient(135deg,rgb(var(--color-accent)_/_0.16),rgb(var(--color-bg-panel)_/_0.94))] text-ink shadow-[inset_3px_0_0_rgb(var(--color-accent)),0_10px_24px_rgb(0_0_0_/_0.12)]"
                  : "border-transparent text-ink-dim hover:border-line/80 hover:bg-bg-panel/70 hover:text-ink",
              )}
            >
              {tab.key === "settings" ? (
                <AutoLintBadge className="absolute right-1.5 top-1.5" />
              ) : null}
              <span className="flex items-center gap-2 text-sm">
                <Icon aria-hidden className="h-4 w-4 shrink-0" />
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
        className={cx(
          "mt-auto flex flex-col gap-2 pb-5 pt-3",
          collapsed ? "px-2" : "px-5",
        )}
      >
        <div
          className={cx(
            "rounded-md border border-line bg-bg/50 p-1 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)]",
            collapsed ? "flex flex-col gap-1" : "",
          )}
          aria-label={t.common.language}
          title={collapsed ? t.common.language : undefined}
        >
          {collapsed ? null : (
            <div className="flex items-center gap-1.5 px-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              <Languages aria-hidden className="h-3 w-3" />
              <span>{t.common.language}</span>
              {savingLanguage ? ` · ${t.sidebar.languageSaving}` : ""}
            </div>
          )}
          <div className={collapsed ? "flex flex-col gap-1" : "grid grid-cols-2 gap-1"}>
            {LANGUAGE_OPTIONS.map(({ code }) => (
              <button
                key={code}
                type="button"
                onClick={() => void onLanguage(code)}
                disabled={savingLanguage}
                className={cx(
                  "h-7 rounded text-[11px] font-medium transition-colors disabled:opacity-50",
                  language === code
                    ? "bg-accent text-bg"
                    : "text-ink-dim hover:bg-bg-panel hover:text-ink",
                )}
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
          className={cx(
            "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line bg-bg/60 px-3 text-xs text-ink-dim hover:border-accent/50 hover:bg-bg-panel hover:text-ink disabled:opacity-50",
            collapsed ? "px-0" : "",
          )}
        >
          <LogOut aria-hidden className="h-4 w-4" />
          {collapsed ? (
            <span className="sr-only">{t.sidebar.logout}</span>
          ) : loggingOut ? (
            t.sidebar.loggingOut
          ) : (
            t.sidebar.logout
          )}
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
