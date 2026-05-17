"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { BRAND_NAME, TEXT, type Language } from "./i18n";
import type { Theme } from "./theme";

type Mode = "setup" | "login";

const MODE_CONFIG = {
  setup: {
    endpoint: "/api/auth/setup",
    requireConfirm: true,
  },
  login: {
    endpoint: "/api/auth/login",
    requireConfirm: false,
  },
} as const;

export default function AuthCard({
  mode,
  language,
  theme,
}: {
  mode: Mode;
  language: Language;
  theme: Theme;
}) {
  const router = useRouter();
  const config = MODE_CONFIG[mode];
  const t = TEXT[language].auth;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (config.requireConfirm && password !== confirm) {
      setError(t.mismatch);
      return;
    }
    if (password.length < 6) {
      setError(t.shortPassword);
      return;
    }

    setPending(true);
    try {
      const res = await fetch(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(j?.error ?? t.requestFailed(res.status));
        setPending(false);
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.network);
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg px-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-xl border border-line bg-bg-panel p-6 shadow-2xl"
      >
        <div className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          {BRAND_NAME}
        </div>
        <h1 className="text-lg font-semibold">
          {mode === "setup" ? t.setupTitle : t.loginTitle}
        </h1>
        <p className="mt-1 text-sm text-ink-dim">
          {mode === "setup" ? t.setupHint : t.loginHint}
        </p>

        <div className="mt-5 flex flex-col gap-3">
          <label className="block">
            <span className="block text-xs text-ink-dim">{t.password}</span>
            <input
              type="password"
              autoComplete={mode === "setup" ? "new-password" : "current-password"}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>

          {config.requireConfirm ? (
            <label className="block">
              <span className="block text-xs text-ink-dim">{t.confirm}</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
          ) : null}

          {error ? (
            <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="mt-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg disabled:opacity-50"
          >
            {pending
              ? t.pending
              : mode === "setup"
                ? t.setupSubmit
                : t.loginSubmit}
          </button>

          <p className="text-[11px] leading-relaxed text-ink-faint">
            {t.storage}
          </p>
        </div>
      </form>
    </div>
  );
}
