"use client";

import { useState } from "react";
import { useLanguage } from "../i18n";
import type { TelegramSettings } from "./types";

type VerifyResult =
  | { ok: true; botUsername: string | null; botName: string | null }
  | { ok: false; error: string };

/**
 * M1 skeleton. Surfaces the bot-token field, an Enable toggle, and a
 * Verify button that calls /api/telegram/test. Allowlist / Pending /
 * Mode (webhook) / response policy controls land in later milestones
 * (M3, M4, M5) per docs/PLAN_TELEGRAM_BOT_2026-06-01.md.
 */
export default function TelegramPanel({
  draft,
  onChange,
  onNotice,
  onError,
}: {
  draft: TelegramSettings;
  onChange: (next: TelegramSettings) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLanguage();
  const [tokenInput, setTokenInput] = useState("");
  const [revealToken, setRevealToken] = useState(false);
  const [busy, setBusy] = useState<"verify" | "save" | null>(null);
  const [lastVerify, setLastVerify] = useState<VerifyResult | null>(null);

  async function saveToken(rawToken: string) {
    setBusy("save");
    try {
      const res = await fetch("/api/telegram/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: rawToken.length > 0 ? rawToken : null }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; set?: boolean; error?: string }
        | null;
      if (!res.ok || !body || body.ok === false) {
        const error = body?.error ?? `save failed (${res.status})`;
        onError(error);
        return;
      }
      onChange({ ...draft, botTokenSet: body.set ?? false });
      setTokenInput("");
      onNotice(
        body.set
          ? t.settings.telegramTokenSaved
          : t.settings.telegramTokenCleared,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function verify(token: string) {
    setBusy("verify");
    setLastVerify(null);
    try {
      const res = await fetch("/api/telegram/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.length > 0 ? token : null }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; botUsername?: string | null; botName?: string | null; error?: string }
        | null;
      if (!res.ok || !body || body.ok === false) {
        const error = body?.error ?? `verify failed (${res.status})`;
        setLastVerify({ ok: false, error });
        onError(error);
        return;
      }
      const result: VerifyResult = {
        ok: true,
        botUsername: body.botUsername ?? null,
        botName: body.botName ?? null,
      };
      setLastVerify(result);
      onNotice(
        result.botUsername
          ? `${t.settings.telegramVerifyOk}: @${result.botUsername}`
          : t.settings.telegramVerifyOk,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLastVerify({ ok: false, error: message });
      onError(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-md border border-line bg-bg-subtle">
      <header className="border-b border-line px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          telegram bot
        </div>
        <h2 className="mt-1 text-sm font-semibold text-ink">
          {t.settings.telegramTitle}
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          {t.settings.telegramDesc}
        </p>
      </header>
      <div className="space-y-4 p-4">
        <label className="flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
          <span className="text-sm font-medium text-ink">
            {t.settings.telegramEnabled}
          </span>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>

        <div className="rounded border border-line bg-bg px-3 py-3">
          <div className="text-xs uppercase tracking-widest text-ink-faint">
            {t.settings.telegramBotToken}
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">
            {t.settings.telegramBotTokenHint}
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type={revealToken ? "text" : "password"}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={
                draft.botTokenSet
                  ? t.settings.telegramBotTokenStored
                  : t.settings.telegramBotTokenPlaceholder
              }
              autoComplete="off"
              className="w-full rounded border border-line bg-bg px-2 py-1 font-mono text-xs text-ink"
            />
            <div className="flex gap-1">
              <button
                type="button"
                className="rounded border border-line bg-bg-subtle px-2 py-1 text-[11px] text-ink-dim hover:text-ink"
                onClick={() => setRevealToken((v) => !v)}
              >
                {revealToken
                  ? t.settings.telegramBotTokenHide
                  : t.settings.telegramBotTokenReveal}
              </button>
              <button
                type="button"
                className="rounded border border-line bg-bg-subtle px-2 py-1 text-[11px] text-ink-dim hover:text-ink disabled:opacity-50"
                onClick={() => verify(tokenInput)}
                disabled={busy === "verify"}
              >
                {busy === "verify"
                  ? t.settings.telegramVerifyRunning
                  : t.settings.telegramVerify}
              </button>
              <button
                type="button"
                className="rounded border border-line bg-accent px-2 py-1 text-[11px] font-semibold text-bg hover:opacity-90 disabled:opacity-50"
                onClick={() => saveToken(tokenInput)}
                disabled={busy === "save" || tokenInput.length === 0}
              >
                {busy === "save"
                  ? t.settings.telegramTokenSaving
                  : t.settings.telegramTokenSave}
              </button>
              {draft.botTokenSet ? (
                <button
                  type="button"
                  className="rounded border border-rose-700/60 bg-bg-subtle px-2 py-1 text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-50"
                  onClick={() => saveToken("")}
                  disabled={busy === "save"}
                >
                  {t.settings.telegramTokenClear}
                </button>
              ) : null}
            </div>
          </div>
          {lastVerify ? (
            <div className="mt-2 text-[11px]">
              {lastVerify.ok ? (
                <span className="text-emerald-400">
                  {t.settings.telegramVerifyOk}
                  {lastVerify.botUsername
                    ? ` · @${lastVerify.botUsername}${
                        lastVerify.botName ? ` (${lastVerify.botName})` : ""
                      }`
                    : ""}
                </span>
              ) : (
                <span className="text-rose-400">
                  {t.settings.telegramVerifyFailed}: {lastVerify.error}
                </span>
              )}
            </div>
          ) : null}
        </div>

        <div className="rounded border border-line bg-bg px-3 py-3">
          <div className="text-xs uppercase tracking-widest text-ink-faint">
            {t.settings.telegramMode}
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">
            {t.settings.telegramModeHint}
          </p>
          <div className="mt-2 flex gap-2 text-[12px]">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="telegram-mode"
                value="polling"
                checked={draft.mode === "polling"}
                onChange={() => onChange({ ...draft, mode: "polling" })}
              />
              {t.settings.telegramModePolling}
            </label>
            <label className="flex items-center gap-1 opacity-50">
              <input
                type="radio"
                name="telegram-mode"
                value="webhook"
                checked={draft.mode === "webhook"}
                disabled
              />
              {t.settings.telegramModeWebhook} ({t.settings.telegramComingSoon})
            </label>
          </div>
        </div>

        <div className="rounded border border-line bg-bg px-3 py-3 text-[11px] text-ink-faint">
          {t.settings.telegramMilestoneNote}
        </div>
      </div>
    </section>
  );
}
