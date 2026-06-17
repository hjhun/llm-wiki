"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLanguage } from "../i18n";
import type {
  TelegramAllowlistEntry,
  TelegramPendingEntry,
  TelegramSettings,
} from "./types";

type VerifyResult =
  | { ok: true; botUsername: string | null; botName: string | null }
  | { ok: false; error: string };

type StatusPayload = {
  enabled: boolean;
  mode: "polling" | "webhook";
  botTokenSet: boolean;
  webhookUrl: string | null;
  webhookSecretSet: boolean;
  stats: {
    startedAt: string;
    webhookRequests: number;
    dispatched: number;
    rejected: number;
    skipped: number;
    throttled: number;
    errors: number;
    lastWebhookAt: string | null;
    lastDispatchAt: string | null;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
  };
  webhook: {
    url: string;
    pendingUpdateCount: number | null;
    lastErrorMessage: string | null;
    lastErrorAt: string | null;
  } | null;
  webhookError: string | null;
  polling: {
    status: "stopped" | "starting" | "running" | "error" | "disabled";
    startedAt: string | null;
    lastPolledAt: string | null;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
    consecutiveErrors: number;
  };
  allowlistCount: number;
  pendingCount: number;
};

/**
 * M2: full webhook flow. Adds Webhook URL/secret management, Allowlist
 * and Pending tables wired to /api/telegram/{approve,revoke}, and a
 * status pane backed by /api/telegram/status.
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
  const { t, formatDateTime } = useLanguage();
  const [tokenInput, setTokenInput] = useState("");
  const [revealToken, setRevealToken] = useState(false);
  const [busy, setBusy] = useState<
    | null
    | "verify"
    | "saveToken"
    | "register"
    | "unregister"
    | "polling"
    | "approve"
    | "revoke"
    | "refresh"
  >(null);
  const [lastVerify, setLastVerify] = useState<VerifyResult | null>(null);
  const [webhookUrl, setWebhookUrl] = useState(draft.webhookPublicUrl ?? "");
  const [status, setStatus] = useState<StatusPayload | null>(null);

  const refreshStatus = useCallback(async () => {
    setBusy("refresh");
    try {
      const res = await fetch("/api/telegram/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`status failed (${res.status})`);
      const body = (await res.json()) as StatusPayload;
      setStatus(body);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [onError]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    setWebhookUrl(draft.webhookPublicUrl ?? "");
  }, [draft.webhookPublicUrl]);

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
        | {
            ok: boolean;
            botUsername?: string | null;
            botName?: string | null;
            error?: string;
          }
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

  async function saveToken(rawToken: string) {
    setBusy("saveToken");
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
      void refreshStatus();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function callSetup(
    action: "register" | "unregister" | "use-polling",
    url?: string,
  ) {
    setBusy(action === "use-polling" ? "polling" : action);
    try {
      const res = await fetch("/api/telegram/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(url ? { webhookUrl: url } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string }
        | null;
      if (!res.ok || !body || body.ok === false) {
        const error = body?.error ?? `${action} failed (${res.status})`;
        onError(error);
        return;
      }
      onChange({
        ...draft,
        mode: action === "register" ? "webhook" : "polling",
        webhookPublicUrl:
          action === "register" ? url ?? draft.webhookPublicUrl : null,
        webhookSecretSet: action === "register" ? true : false,
      });
      onNotice(
        action === "register"
          ? t.settings.telegramWebhookRegistered
          : action === "use-polling"
            ? t.settings.telegramPollingSwitched
            : t.settings.telegramWebhookUnregistered,
      );
      void refreshStatus();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function approveChat(
    chatId: number,
    permission: "query" | "trusted",
  ) {
    setBusy("approve");
    try {
      const res = await fetch("/api/telegram/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, permission }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string }
        | null;
      if (!res.ok || !body || body.ok === false) {
        onError(body?.error ?? `approve failed (${res.status})`);
        return;
      }
      const movedEntry = draft.pending.find((entry) => entry.chatId === chatId);
      const nextPending = draft.pending.filter(
        (entry) => entry.chatId !== chatId,
      );
      const nextAllowlist = draft.allowlist.filter(
        (entry) => entry.chatId !== chatId,
      );
      nextAllowlist.push({
        chatId,
        kind: movedEntry?.kind ?? "private",
        label: movedEntry?.label ?? "",
        permission,
        approvedAt: new Date().toISOString(),
      });
      onChange({
        ...draft,
        pending: nextPending,
        allowlist: nextAllowlist,
      });
      onNotice(t.settings.telegramApproved);
      void refreshStatus();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function revokeChat(
    chatId: number,
    target: "allowlist" | "pending" | "both",
  ) {
    setBusy("revoke");
    try {
      const res = await fetch("/api/telegram/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, target }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string }
        | null;
      if (!res.ok || !body || body.ok === false) {
        onError(body?.error ?? `revoke failed (${res.status})`);
        return;
      }
      onChange({
        ...draft,
        allowlist:
          target === "pending"
            ? draft.allowlist
            : draft.allowlist.filter((entry) => entry.chatId !== chatId),
        pending:
          target === "allowlist"
            ? draft.pending
            : draft.pending.filter((entry) => entry.chatId !== chatId),
      });
      onNotice(t.settings.telegramRevoked);
      void refreshStatus();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const allowlist = useMemo(
    () => [...draft.allowlist].sort((a, b) => a.chatId - b.chatId),
    [draft.allowlist],
  );
  const pending = useMemo(
    () => [...draft.pending].sort((a, b) => a.chatId - b.chatId),
    [draft.pending],
  );

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

        <BotTokenSection
          draft={draft}
          tokenInput={tokenInput}
          revealToken={revealToken}
          busy={busy}
          lastVerify={lastVerify}
          setRevealToken={setRevealToken}
          setTokenInput={setTokenInput}
          verify={verify}
          saveToken={saveToken}
          t={t}
        />

        <WebhookSection
          draft={draft}
          webhookUrl={webhookUrl}
          busy={busy}
          setWebhookUrl={setWebhookUrl}
          register={(url) => callSetup("register", url)}
          unregister={() => callSetup("unregister")}
          usePolling={() => callSetup("use-polling")}
          t={t}
        />

        <PendingTable
          pending={pending}
          busy={busy}
          approve={approveChat}
          revoke={revokeChat}
          t={t}
        />

        <AllowlistTable
          allowlist={allowlist}
          busy={busy}
          revoke={revokeChat}
          t={t}
        />

        <StatusPanel
          status={status}
          busy={busy}
          refresh={refreshStatus}
          t={t}
        />
      </div>
    </section>
  );
}

function BotTokenSection(props: {
  draft: TelegramSettings;
  tokenInput: string;
  revealToken: boolean;
  busy: string | null;
  lastVerify: VerifyResult | null;
  setRevealToken: (next: boolean | ((prev: boolean) => boolean)) => void;
  setTokenInput: (next: string) => void;
  verify: (token: string) => Promise<void>;
  saveToken: (token: string) => Promise<void>;
  t: ReturnType<typeof useLanguage>["t"];
}) {
  const {
    draft,
    tokenInput,
    revealToken,
    busy,
    lastVerify,
    setRevealToken,
    setTokenInput,
    verify,
    saveToken,
    t,
  } = props;
  return (
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
            onClick={() => setRevealToken((v: boolean) => !v)}
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
            className="rounded border border-accent/40 bg-accent px-2 py-1 text-[11px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => saveToken(tokenInput)}
            disabled={busy === "saveToken" || tokenInput.length === 0}
          >
            {busy === "saveToken"
              ? t.settings.telegramTokenSaving
              : t.settings.telegramTokenSave}
          </button>
          {draft.botTokenSet ? (
            <button
              type="button"
              className="rounded border border-rose-700/60 bg-bg-subtle px-2 py-1 text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-50"
              onClick={() => saveToken("")}
              disabled={busy === "saveToken"}
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
  );
}

function WebhookSection(props: {
  draft: TelegramSettings;
  webhookUrl: string;
  busy: string | null;
  setWebhookUrl: (next: string) => void;
  register: (url: string) => void;
  unregister: () => void;
  usePolling: () => void;
  t: ReturnType<typeof useLanguage>["t"];
}) {
  const {
    draft,
    webhookUrl,
    busy,
    setWebhookUrl,
    register,
    unregister,
    usePolling,
    t,
  } = props;
  const isRegistered = draft.mode === "webhook" && draft.webhookSecretSet;
  const isPolling = draft.mode === "polling";
  return (
    <div className="rounded border border-line bg-bg px-3 py-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-widest text-ink-faint">
          {t.settings.telegramDeliverySection}
        </div>
        <div className="font-mono text-[11px] uppercase text-ink">
          {draft.mode}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">
        {t.settings.telegramWebhookHint}
      </p>
      <div className="mt-2 grid gap-2">
        <label className="block">
          <span className="text-[11px] text-ink-faint">
            {t.settings.telegramWebhookUrl}
          </span>
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://your.host/api/telegram/webhook"
            className="mt-1 w-full rounded border border-line bg-bg px-2 py-1 font-mono text-xs text-ink"
          />
        </label>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <button
            type="button"
            className="rounded border border-accent/40 bg-accent px-2 py-1 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => register(webhookUrl.trim())}
            disabled={
              busy === "register" ||
              webhookUrl.trim().length === 0 ||
              !draft.botTokenSet
            }
          >
            {busy === "register"
              ? t.settings.telegramWebhookRegistering
              : t.settings.telegramWebhookRegister}
          </button>
          {isRegistered ? (
            <button
              type="button"
              className="rounded border border-rose-700/60 bg-bg-subtle px-2 py-1 text-rose-300 hover:text-rose-200 disabled:opacity-50"
              onClick={unregister}
              disabled={busy === "unregister"}
            >
              {busy === "unregister"
                ? t.settings.telegramWebhookUnregistering
                : t.settings.telegramWebhookUnregister}
            </button>
          ) : null}
          {!isPolling ? (
            <button
              type="button"
              className="rounded border border-line bg-bg-subtle px-2 py-1 text-ink-dim hover:text-ink disabled:opacity-50"
              onClick={usePolling}
              disabled={busy === "polling" || !draft.botTokenSet}
            >
              {busy === "polling"
                ? t.settings.telegramPollingSwitching
                : t.settings.telegramPollingUse}
            </button>
          ) : null}
        </div>
        <p className="text-[11px] text-ink-faint">
          {t.settings.telegramWebhookHttpsNote}
        </p>
        <p className="text-[11px] text-ink-faint">
          {t.settings.telegramPollingHint}
        </p>
        <p className="text-[11px] text-ink-faint">
          {t.settings.telegramWebhookSecretStatus}:{" "}
          <span
            className={
              draft.webhookSecretSet ? "text-emerald-400" : "text-rose-400"
            }
          >
            {draft.webhookSecretSet
              ? t.settings.telegramWebhookSecretSet
              : t.settings.telegramWebhookSecretMissing}
          </span>
        </p>
      </div>
    </div>
  );
}

function PendingTable(props: {
  pending: TelegramPendingEntry[];
  busy: string | null;
  approve: (chatId: number, permission: "query" | "trusted") => Promise<void>;
  revoke: (
    chatId: number,
    target: "allowlist" | "pending" | "both",
  ) => Promise<void>;
  t: ReturnType<typeof useLanguage>["t"];
}) {
  const { pending, busy, approve, revoke, t } = props;
  return (
    <div className="rounded border border-line bg-bg px-3 py-3">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-widest text-ink-faint">
          {t.settings.telegramPending}
        </div>
        <div className="text-[11px] text-ink-faint">
          {pending.length} {t.settings.telegramPendingCount}
        </div>
      </div>
      {pending.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-faint">
          {t.settings.telegramPendingEmpty}
        </p>
      ) : (
        <table className="mt-2 w-full text-[11px]">
          <thead className="text-ink-faint">
            <tr>
              <th className="text-left">chat id</th>
              <th className="text-left">kind</th>
              <th className="text-left">{t.settings.telegramLabel}</th>
              <th className="text-left">{t.settings.telegramPreview}</th>
              <th className="text-right">{t.settings.telegramActions}</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((entry) => (
              <tr key={entry.chatId} className="border-t border-line">
                <td className="py-1 font-mono">{entry.chatId}</td>
                <td className="py-1">{entry.kind}</td>
                <td className="py-1">{entry.label}</td>
                <td className="py-1 text-ink-dim">{entry.lastMessagePreview}</td>
                <td className="py-1 text-right">
                  <div className="inline-flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="rounded border border-accent/40 bg-accent px-2 py-0.5 text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                      onClick={() => approve(entry.chatId, "query")}
                      disabled={busy === "approve"}
                    >
                      {t.settings.telegramApproveQuery}
                    </button>
                    <button
                      type="button"
                      className="rounded border border-line bg-bg-subtle px-2 py-0.5 text-ink-dim hover:text-ink disabled:opacity-50"
                      onClick={() => approve(entry.chatId, "trusted")}
                      disabled={busy === "approve"}
                    >
                      {t.settings.telegramApproveTrusted}
                    </button>
                    <button
                      type="button"
                      className="rounded border border-rose-700/60 bg-bg-subtle px-2 py-0.5 text-rose-300 hover:text-rose-200 disabled:opacity-50"
                      onClick={() => revoke(entry.chatId, "pending")}
                      disabled={busy === "revoke"}
                    >
                      {t.settings.telegramReject}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AllowlistTable(props: {
  allowlist: TelegramAllowlistEntry[];
  busy: string | null;
  revoke: (
    chatId: number,
    target: "allowlist" | "pending" | "both",
  ) => Promise<void>;
  t: ReturnType<typeof useLanguage>["t"];
}) {
  const { allowlist, busy, revoke, t } = props;
  const { formatDateTime } = useLanguage();
  return (
    <div className="rounded border border-line bg-bg px-3 py-3">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-widest text-ink-faint">
          {t.settings.telegramAllowlist}
        </div>
        <div className="text-[11px] text-ink-faint">
          {allowlist.length} {t.settings.telegramAllowlistCount}
        </div>
      </div>
      {allowlist.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-faint">
          {t.settings.telegramAllowlistEmpty}
        </p>
      ) : (
        <table className="mt-2 w-full text-[11px]">
          <thead className="text-ink-faint">
            <tr>
              <th className="text-left">chat id</th>
              <th className="text-left">kind</th>
              <th className="text-left">{t.settings.telegramLabel}</th>
              <th className="text-left">{t.settings.telegramPermission}</th>
              <th className="text-left">{t.settings.telegramApprovedAt}</th>
              <th className="text-right">{t.settings.telegramActions}</th>
            </tr>
          </thead>
          <tbody>
            {allowlist.map((entry) => (
              <tr key={entry.chatId} className="border-t border-line">
                <td className="py-1 font-mono">{entry.chatId}</td>
                <td className="py-1">{entry.kind}</td>
                <td className="py-1">{entry.label}</td>
                <td className="py-1">
                  <span
                    className={
                      entry.permission === "trusted"
                        ? "text-amber-300"
                        : "text-ink"
                    }
                  >
                    {entry.permission}
                  </span>
                </td>
                <td className="py-1 text-ink-dim">
                  {formatDateTime(entry.approvedAt)}
                </td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    className="rounded border border-rose-700/60 bg-bg-subtle px-2 py-0.5 text-rose-300 hover:text-rose-200 disabled:opacity-50"
                    onClick={() => revoke(entry.chatId, "allowlist")}
                    disabled={busy === "revoke"}
                  >
                    {t.settings.telegramRevoke}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusPanel(props: {
  status: StatusPayload | null;
  busy: string | null;
  refresh: () => Promise<void>;
  t: ReturnType<typeof useLanguage>["t"];
}) {
  const { status, busy, refresh, t } = props;
  const { formatDateTime } = useLanguage();
  return (
    <div className="rounded border border-line bg-bg px-3 py-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-widest text-ink-faint">
          {t.settings.telegramStatus}
        </div>
        <button
          type="button"
          className="rounded border border-line bg-bg-subtle px-2 py-1 text-[11px] text-ink-dim hover:text-ink disabled:opacity-50"
          onClick={refresh}
          disabled={busy === "refresh"}
        >
          {busy === "refresh"
            ? t.settings.telegramStatusRefreshing
            : t.settings.telegramStatusRefresh}
        </button>
      </div>
      {status === null ? (
        <p className="mt-2 text-[11px] text-ink-faint">
          {t.settings.telegramStatusLoading}
        </p>
      ) : (
        <div className="mt-2 grid gap-2 text-[11px]">
          <div>
            <span className="text-ink-faint">
              {t.settings.telegramStatusMode}:
            </span>{" "}
            <span className="text-ink">{status.mode}</span>
          </div>
          <div>
            <span className="text-ink-faint">
              {t.settings.telegramStatusWebhookUrl}:
            </span>{" "}
            <span className="font-mono text-ink-dim">
              {status.webhookUrl ?? "—"}
            </span>
          </div>
          {status.webhook ? (
            <div>
              <span className="text-ink-faint">
                {t.settings.telegramStatusUpstreamPending}:
              </span>{" "}
              <span className="text-ink">
                {status.webhook.pendingUpdateCount ?? "—"}
              </span>
              {status.webhook.lastErrorMessage ? (
                <span className="ml-2 text-rose-300">
                  {status.webhook.lastErrorMessage}{" "}
                  ({formatDateTime(status.webhook.lastErrorAt)})
                </span>
              ) : null}
            </div>
          ) : null}
          {status.webhookError ? (
            <div className="text-rose-300">
              {t.settings.telegramStatusUpstreamError}: {status.webhookError}
            </div>
          ) : null}
          <div className="rounded border border-line px-2 py-1">
            <div className="text-ink-faint">
              {t.settings.telegramPollingStatus}
            </div>
            <div className="font-mono text-ink">
              {status.polling.status}
              {status.polling.consecutiveErrors > 0
                ? ` · ${status.polling.consecutiveErrors} errors`
                : ""}
            </div>
            <div className="text-ink-dim">
              {t.settings.telegramPollingLastPolled}:{" "}
              {formatDateTime(status.polling.lastPolledAt)}
            </div>
            {status.polling.lastErrorMessage ? (
              <div className="text-rose-200">
                {status.polling.lastErrorMessage} ·{" "}
                {formatDateTime(status.polling.lastErrorAt)}
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            <Stat label={t.settings.telegramStatStartedAt} value={formatDateTime(status.stats.startedAt)} />
            <Stat label={t.settings.telegramStatRequests} value={String(status.stats.webhookRequests)} />
            <Stat label={t.settings.telegramStatDispatched} value={String(status.stats.dispatched)} />
            <Stat label={t.settings.telegramStatRejected} value={String(status.stats.rejected)} />
            <Stat label={t.settings.telegramStatSkipped} value={String(status.stats.skipped)} />
            <Stat label={t.settings.telegramStatThrottled} value={String(status.stats.throttled)} />
            <Stat label={t.settings.telegramStatErrors} value={String(status.stats.errors)} />
            <Stat label={t.settings.telegramStatLastWebhook} value={formatDateTime(status.stats.lastWebhookAt)} />
            <Stat label={t.settings.telegramStatLastDispatch} value={formatDateTime(status.stats.lastDispatchAt)} />
            <Stat label={t.settings.telegramStatLastError} value={formatDateTime(status.stats.lastErrorAt)} />
          </div>
          {status.stats.lastErrorMessage ? (
            <div className="rounded border border-rose-700/60 bg-bg-subtle px-2 py-1 text-rose-200">
              {status.stats.lastErrorMessage}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-ink-faint">{label}</div>
      <div className="font-mono text-ink">{value}</div>
    </div>
  );
}
