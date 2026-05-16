"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type Mode = "setup" | "login";

const TEXT = {
  setup: {
    title: "비밀번호 설정",
    hint: "이 인스턴스의 관리자 비밀번호를 처음 설정합니다. 6자 이상.",
    submit: "비밀번호 설정 후 시작",
    endpoint: "/api/auth/setup",
    requireConfirm: true,
  },
  login: {
    title: "로그인",
    hint: "이 인스턴스의 관리자 비밀번호를 입력하세요.",
    submit: "로그인",
    endpoint: "/api/auth/login",
    requireConfirm: false,
  },
} as const;

export default function AuthCard({ mode }: { mode: Mode }) {
  const router = useRouter();
  const t = TEXT[mode];
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (t.requireConfirm && password !== confirm) {
      setError("두 비밀번호가 일치하지 않습니다.");
      return;
    }
    if (password.length < 6) {
      setError("비밀번호는 6자 이상이어야 합니다.");
      return;
    }

    setPending(true);
    try {
      const res = await fetch(t.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(j?.error ?? `요청 실패 (${res.status})`);
        setPending(false);
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "네트워크 오류");
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
          llm wiki
        </div>
        <h1 className="text-lg font-semibold">{t.title}</h1>
        <p className="mt-1 text-sm text-ink-dim">{t.hint}</p>

        <div className="mt-5 flex flex-col gap-3">
          <label className="block">
            <span className="block text-xs text-ink-dim">비밀번호</span>
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

          {t.requireConfirm ? (
            <label className="block">
              <span className="block text-xs text-ink-dim">비밀번호 확인</span>
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
            {pending ? "처리 중..." : t.submit}
          </button>

          <p className="text-[11px] leading-relaxed text-ink-faint">
            비밀번호와 세션 시크릿은{" "}
            <span className="font-mono">config/local.json</span>에 저장되며 git
            추적에서 제외됩니다.
          </p>
        </div>
      </form>
    </div>
  );
}
