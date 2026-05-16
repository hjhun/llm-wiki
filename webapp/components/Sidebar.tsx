"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Tab = {
  href: string;
  label: string;
  icon: string;
  desc: string;
};

const TABS: Tab[] = [
  { href: "/chat", label: "Chat", icon: "💬", desc: "코딩 에이전트와 대화" },
  { href: "/explorer", label: "Explorer", icon: "📁", desc: "wiki/raw 탐색" },
  { href: "/graph", label: "Knowledge Graph", icon: "🕸", desc: "지식 그래프" },
  { href: "/settings", label: "Settings", icon: "⚙", desc: "CLI · 비밀번호" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
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
              llm wiki
            </div>
            <div className="mt-1 text-sm text-ink-dim">local</div>
          </div>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
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
          return (
            <Link
              key={tab.href}
              href={tab.href}
              title={collapsed ? tab.label : undefined}
              className={[
                "group flex rounded-md transition-colors",
                collapsed
                  ? "h-10 items-center justify-center px-0 py-0"
                  : "flex-col px-3 py-2",
                active
                  ? "bg-bg-panel text-ink"
                  : "text-ink-dim hover:bg-bg-panel/60 hover:text-ink",
              ].join(" ")}
            >
              <span className="flex items-center gap-2 text-sm">
                <span aria-hidden className="text-base leading-none">
                  {tab.icon}
                </span>
                <span className={collapsed ? "sr-only" : "font-medium"}>
                  {tab.label}
                </span>
              </span>
              {collapsed ? null : (
                <span
                  className={[
                    "ml-7 text-[11px] leading-tight transition-colors",
                    active ? "text-ink-dim" : "text-ink-faint",
                  ].join(" ")}
                >
                  {tab.desc}
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
        <button
          type="button"
          onClick={onLogout}
          disabled={loggingOut}
          title={collapsed ? "Logout" : undefined}
          className={[
            "rounded-md border border-line bg-bg/60 px-3 py-2 text-xs text-ink-dim hover:bg-bg-panel hover:text-ink disabled:opacity-50",
            collapsed ? "px-0" : "",
          ].join(" ")}
        >
          {collapsed ? "⎋" : loggingOut ? "로그아웃 중..." : "로그아웃"}
        </button>
        {collapsed ? null : (
          <div className="rounded-md border border-line bg-bg/40 px-3 py-2 text-[11px] leading-snug text-ink-faint">
            이 인스턴스는 <span className="text-ink-dim">로컬 전용</span>입니다.
            <br />
            기본 bind: <span className="font-mono">127.0.0.1</span>
          </div>
        )}
      </div>
    </aside>
  );
}
