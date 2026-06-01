"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckSquare,
  Eraser,
  LoaderCircle,
  LockKeyhole,
  MessageSquarePlus,
  Send,
  Trash2,
  UserRound,
} from "lucide-react";
import { useLanguage } from "../i18n";
import AgentMascot from "../agent-panel/AgentMascot";
import MarkdownContent from "../chat/MarkdownContent";
import MessageCopyButton from "../chat/MessageCopyButton";
import { Button, IconButton, StatusBadge, cx } from "../ui";

type PublicMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  ts: string;
  content: string;
};

type PublicConversation = {
  id: string;
  title: string;
  created: string;
  updated: string;
  messages: PublicMessage[];
};

type PublicQueryResponse = {
  mode: "query";
  question: string;
  answer: string;
  sources: Array<{ path: string; title: string; score: number }>;
  agent: string | null;
  durationMs: number;
};

const LEGACY_MESSAGES_KEY = "clio.public.messages.v1";
const CONVERSATIONS_KEY = "clio.public.conversations.v1";
const VISITOR_ID_KEY = "clio.public.visitorId.v1";
const ACCESS_TOKEN_KEY = "clio.public.accessToken.v1";
const PUBLIC_HISTORY_LIMIT = 12;
const PUBLIC_HISTORY_MESSAGE_LIMIT = 8000;

function nowStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function getVisitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;
    const next = newId();
    localStorage.setItem(VISITOR_ID_KEY, next);
    return next;
  } catch {
    return newId();
  }
}

function isPublicMessage(item: unknown): item is PublicMessage {
  return (
    Boolean(item) &&
    typeof item === "object" &&
    typeof (item as PublicMessage).id === "string" &&
    ((item as PublicMessage).role === "user" ||
      (item as PublicMessage).role === "assistant" ||
      (item as PublicMessage).role === "system") &&
    typeof (item as PublicMessage).ts === "string" &&
    typeof (item as PublicMessage).content === "string"
  );
}

function compactTitle(input: string): string {
  const title = input.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 58) : "New query";
}

function sortConversations(
  conversations: PublicConversation[],
): PublicConversation[] {
  return [...conversations].sort(
    (a, b) => Date.parse(b.updated) - Date.parse(a.updated),
  );
}

function buildRequestHistory(
  conversation: PublicConversation | null,
): Array<{ role: "user" | "assistant"; content: string }> {
  return (conversation?.messages ?? [])
    .filter(
      (
        message,
      ): message is PublicMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .slice(-PUBLIC_HISTORY_LIMIT)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, PUBLIC_HISTORY_MESSAGE_LIMIT),
    }));
}

function loadConversations(): PublicConversation[] {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PublicConversation[];
      if (Array.isArray(parsed)) {
        return sortConversations(
          parsed.filter(
            (item) =>
              item &&
              typeof item.id === "string" &&
              typeof item.title === "string" &&
              typeof item.created === "string" &&
              typeof item.updated === "string" &&
              Array.isArray(item.messages) &&
              item.messages.every(isPublicMessage),
          ),
        );
      }
    }

    const legacyRaw = localStorage.getItem(LEGACY_MESSAGES_KEY);
    if (!legacyRaw) return [];
    const legacy = JSON.parse(legacyRaw) as PublicMessage[];
    if (!Array.isArray(legacy)) return [];
    const messages = legacy.filter(isPublicMessage);
    if (messages.length === 0) return [];
    const firstUser = messages.find((message) => message.role === "user");
    const now = new Date().toISOString();
    return [
      {
        id: newId(),
        title: compactTitle(firstUser?.content ?? "Previous CLIO chat"),
        created: now,
        updated: now,
        messages,
      },
    ];
  } catch {
    return [];
  }
}

async function asError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? `request failed (${res.status})`);
}

export default function PublicClioChat({
  appSubtitle,
  accessRequired = false,
}: {
  appSubtitle?: string;
  accessRequired?: boolean;
}) {
  const [conversations, setConversations] = useState<PublicConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [accessInput, setAccessInput] = useState("");
  const [accessError, setAccessError] = useState<string | null>(null);
  const { language } = useLanguage();
  const isKorean = language === "ko";
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const activeConversation =
    conversations.find((conversation) => conversation.id === activeId) ?? null;
  const messages = activeConversation?.messages ?? [];
  const selectedCount = selectedIds.size;
  const allSelected =
    conversations.length > 0 && selectedCount === conversations.length;

  useEffect(() => {
    const loaded = loadConversations();
    setConversations(loaded);
    setActiveId(loaded[0]?.id ?? null);
    try {
      setAccessToken(sessionStorage.getItem(ACCESS_TOKEN_KEY));
    } catch {
      /* sessionStorage unavailable */
    }
    setHydrated(true);
  }, []);

  function submitAccessToken() {
    const token = accessInput.trim();
    if (!token) return;
    try {
      sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
    } catch {
      /* sessionStorage unavailable; keep it in memory for this session */
    }
    setAccessToken(token);
    setAccessInput("");
    setAccessError(null);
  }

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
  }, [conversations, hydrated]);

  useEffect(() => {
    setSelectedIds((current) => {
      const visible = new Set(conversations.map((conversation) => conversation.id));
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [conversations]);

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = `${Math.min(taRef.current.scrollHeight, 240)}px`;
  }, [value]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, pending]);

  async function send() {
    const message = value.trim();
    if (!message || pending) return;

    const conversationId = activeId ?? newId();
    const history = buildRequestHistory(activeConversation);
    const nowIso = new Date().toISOString();
    const userMessage: PublicMessage = {
      id: newId(),
      role: "user",
      ts: nowStamp(),
      content: message,
    };
    setConversations((current) => {
      const existing = current.find(
        (conversation) => conversation.id === conversationId,
      );
      if (!existing) {
        return sortConversations([
          {
            id: conversationId,
            title: compactTitle(message),
            created: nowIso,
            updated: nowIso,
            messages: [userMessage],
          },
          ...current,
        ]);
      }
      return sortConversations(
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                title:
                  conversation.messages.length === 0
                    ? compactTitle(message)
                    : conversation.title,
                updated: nowIso,
                messages: [...conversation.messages, userMessage],
              }
            : conversation,
        ),
      );
    });
    setActiveId(conversationId);
    setValue("");
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/public/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { "x-clio-access-token": accessToken } : {}),
        },
        body: JSON.stringify({
          message,
          visitorId: getVisitorId(),
          conversationId,
          history,
        }),
      });
      if (res.status === 401) {
        // Passphrase missing/incorrect — clear it and re-prompt.
        try {
          sessionStorage.removeItem(ACCESS_TOKEN_KEY);
        } catch {
          /* ignore */
        }
        setAccessToken(null);
        setAccessError("passphrase");
        setPending(false);
        return;
      }
      if (!res.ok) throw await asError(res);
      const data = (await res.json()) as PublicQueryResponse;
      appendMessage(conversationId, {
        id: newId(),
        role: "assistant",
        ts: nowStamp(),
        content: data.answer,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      appendMessage(conversationId, {
        id: newId(),
        role: "system",
        ts: nowStamp(),
        content: msg,
      });
    } finally {
      setPending(false);
    }
  }

  function appendMessage(conversationId: string, message: PublicMessage) {
    setConversations((current) =>
      sortConversations(
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                updated: new Date().toISOString(),
                messages: [...conversation.messages, message],
              }
            : conversation,
        ),
      ),
    );
  }

  function newConversation() {
    if (pending) return;
    setActiveId(null);
    setValue("");
    setError(null);
  }

  function clearActive() {
    if (!activeConversation || pending) return;
    const ok = window.confirm("현재 대화 내용을 비울까요?");
    if (!ok) return;
    setConversations((current) =>
      sortConversations(
        current.map((conversation) =>
          conversation.id === activeConversation.id
            ? {
                ...conversation,
                updated: new Date().toISOString(),
                messages: [],
              }
            : conversation,
        ),
      ),
    );
    setError(null);
  }

  function toggleConversation(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds(
      allSelected ? new Set() : new Set(conversations.map((item) => item.id)),
    );
  }

  function deleteSelected() {
    if (selectedCount === 0 || pending) return;
    const ok = window.confirm(
      `선택한 대화 ${selectedCount}개를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`,
    );
    if (!ok) return;
    const ids = new Set(selectedIds);
    const nextConversations = conversations.filter(
      (conversation) => !ids.has(conversation.id),
    );
    setConversations(nextConversations);
    if (activeId && ids.has(activeId)) {
      setActiveId(nextConversations[0]?.id ?? null);
    }
    setSelectedIds(new Set());
    setError(null);
  }

  if (hydrated && accessRequired && !accessToken) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-bg px-6 text-ink">
        <form
          className="w-full max-w-sm rounded-md border border-line bg-bg-panel/82 p-6 shadow-sm backdrop-blur-xl"
          onSubmit={(e) => {
            e.preventDefault();
            submitAccessToken();
          }}
        >
          <div className="flex items-center gap-2 text-ink">
            <LockKeyhole className="h-4 w-4" />
            <h1 className="text-lg font-semibold">
              {isKorean ? "접근 패스프레이즈가 필요합니다" : "Access passphrase required"}
            </h1>
          </div>
          {appSubtitle ? (
            <div className="mt-1 text-xs text-ink-dim">{appSubtitle}</div>
          ) : null}
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            {isKorean
              ? "이 공개 채팅은 관리자가 설정한 패스프레이즈로 보호됩니다. 패스프레이즈를 입력하세요."
              : "This shared chat is protected by an administrator passphrase. Enter it to continue."}
          </p>
          <input
            type="password"
            autoFocus
            value={accessInput}
            onChange={(e) => setAccessInput(e.target.value)}
            placeholder={isKorean ? "패스프레이즈" : "Passphrase"}
            className="mt-4 w-full rounded border border-line bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
          {accessError ? (
            <p className="mt-2 text-xs text-danger">
              {isKorean
                ? "패스프레이즈가 올바르지 않습니다. 다시 시도해주세요."
                : "Incorrect passphrase. Please try again."}
            </p>
          ) : null}
          <Button type="submit" disabled={!accessInput.trim()} className="mt-4 w-full">
            {isKorean ? "계속" : "Continue"}
          </Button>
        </form>
      </main>
    );
  }

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-bg/80 text-ink">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-bg-subtle/82 lg:flex lg:flex-col">
        <PublicConversationList
          conversations={conversations}
          activeId={activeId}
          selectedIds={selectedIds}
          pending={pending}
          allSelected={allSelected}
          selectedCount={selectedCount}
          onNew={newConversation}
          onSelect={(id) => {
            if (pending) return;
            setActiveId(id);
            setError(null);
          }}
          onToggle={toggleConversation}
          onToggleAll={toggleAll}
          onDelete={deleteSelected}
          running={pending}
        />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-bg-panel/76 px-5 py-3 shadow-sm backdrop-blur-xl">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              {appSubtitle ? `public clio · ${appSubtitle}` : "public clio"}
            </div>
            <h1 className="truncate text-base font-semibold text-ink">
              {activeConversation?.title ?? "CLIO Query"}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge tone="ready">
              <LockKeyhole aria-hidden className="mr-1 h-3 w-3" />
              query only
            </StatusBadge>
            <IconButton
              icon={MessageSquarePlus}
              label="New local chat"
              onClick={newConversation}
              disabled={pending}
              variant="ghost"
              className="lg:hidden"
            />
            <IconButton
              icon={Eraser}
              label="Clear current chat"
              onClick={clearActive}
              disabled={pending || !activeConversation || messages.length === 0}
              variant="ghost"
            />
          </div>
        </header>

        <div className="border-b border-line bg-bg-subtle/70 px-3 py-2 lg:hidden">
          <PublicConversationStrip
            conversations={conversations}
            activeId={activeId}
            selectedIds={selectedIds}
            pending={pending}
            selectedCount={selectedCount}
            onSelect={(id) => {
              if (pending) return;
              setActiveId(id);
              setError(null);
            }}
            onToggle={toggleConversation}
            onDelete={deleteSelected}
          />
        </div>

        {error ? (
          <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1 text-[11px] text-red-300">
            {error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-h-full flex-col gap-4 px-5 py-5 sm:px-6 lg:px-8">
            {messages.length === 0 ? (
              <div className="flex min-h-40 flex-col justify-end border-b border-line/70 pb-6">
                <div className="max-w-2xl text-2xl font-semibold leading-tight text-ink sm:text-3xl">
                  wiki에 대해 물어보세요.
                </div>
              </div>
            ) : null}

            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}

            {pending ? (
              <article className="rounded-md border border-line bg-bg-subtle px-5 py-4 text-[15px]">
                <header className="mb-2 flex items-center gap-2 text-[11px] text-ink-faint">
                  <LoaderCircle
                    aria-hidden
                    className="h-3.5 w-3.5 animate-spin"
                  />
                  <span className="font-mono uppercase tracking-widest">
                    query
                  </span>
                </header>
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:120ms]" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:240ms]" />
                </div>
              </article>
            ) : null}
            <div ref={endRef} />
          </div>
        </div>

        <div className="border-t border-line bg-bg-subtle px-5 py-4 sm:px-6 lg:px-8">
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              rows={1}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="질문 입력"
              disabled={pending}
              className="block w-full resize-none rounded-md border border-line bg-bg px-4 py-3 text-[15px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent disabled:opacity-60"
            />
            <Button
              onClick={() => void send()}
              disabled={pending || !value.trim()}
              variant="primary"
              size="md"
              icon={pending ? LoaderCircle : Send}
              className={cx(pending && "[&>svg]:animate-spin")}
            >
              Send
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

function PublicConversationList({
  conversations,
  activeId,
  selectedIds,
  pending,
  allSelected,
  selectedCount,
  onNew,
  onSelect,
  onToggle,
  onToggleAll,
  onDelete,
  running,
}: {
  conversations: PublicConversation[];
  activeId: string | null;
  selectedIds: Set<string>;
  pending: boolean;
  allSelected: boolean;
  selectedCount: number;
  onNew: () => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onDelete: () => void;
  running: boolean;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-line p-2">
        <Button
          onClick={onNew}
          variant="primary"
          icon={MessageSquarePlus}
          className="w-full"
          disabled={pending}
        >
          New Chat
        </Button>
        <div className="mt-2">
          <AgentMascot running={running} />
        </div>
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
          <Button
            onClick={onToggleAll}
            disabled={conversations.length === 0 || pending}
            variant="secondary"
            icon={CheckSquare}
            className="h-7 text-[11px]"
          >
            {allSelected ? "Clear" : "Select all"}
          </Button>
          <Button
            onClick={onDelete}
            disabled={selectedCount === 0 || pending}
            variant="danger"
            icon={Trash2}
            className="h-7 px-2 text-[11px]"
          >
            Delete {selectedCount || ""}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {conversations.length === 0 ? (
          <div className="m-2 rounded-md border border-dashed border-line bg-bg-panel/68 px-3 py-5 text-center text-xs text-ink-faint">
            No local chats yet.
          </div>
        ) : (
          conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={activeId === conversation.id}
              selected={selectedIds.has(conversation.id)}
              disabled={pending}
              onSelect={() => onSelect(conversation.id)}
              onToggle={() => onToggle(conversation.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PublicConversationStrip({
  conversations,
  activeId,
  selectedIds,
  pending,
  selectedCount,
  onSelect,
  onToggle,
  onDelete,
}: {
  conversations: PublicConversation[];
  activeId: string | null;
  selectedIds: Set<string>;
  pending: boolean;
  selectedCount: number;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onDelete: () => void;
}) {
  if (conversations.length === 0) {
    return (
      <div className="text-xs text-ink-faint">
        Local browser history will appear here.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      {conversations.map((conversation) => (
        <div
          key={conversation.id}
          className={cx(
            "flex min-w-48 shrink-0 items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
            activeId === conversation.id
              ? "border-accent bg-bg-panel text-ink"
              : "border-line bg-bg-panel/62 text-ink-dim",
          )}
        >
          <input
            type="checkbox"
            checked={selectedIds.has(conversation.id)}
            onChange={() => onToggle(conversation.id)}
            disabled={pending}
            aria-label={`Select ${conversation.title}`}
            className="h-3.5 w-3.5 accent-accent"
          />
          <button
            type="button"
            onClick={() => onSelect(conversation.id)}
            disabled={pending}
            className="min-w-0 flex-1 text-left disabled:opacity-60"
          >
            <span className="block truncate font-medium">{conversation.title}</span>
            <span className="block truncate font-mono text-[10px] text-ink-faint">
              {conversation.messages.length} messages
            </span>
          </button>
        </div>
      ))}
      <IconButton
        icon={Trash2}
        label="Delete selected chats"
        onClick={onDelete}
        disabled={selectedCount === 0 || pending}
        variant="danger"
        className="shrink-0"
      />
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  selected,
  disabled,
  onSelect,
  onToggle,
}: {
  conversation: PublicConversation;
  active: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className={cx(
        "grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 px-3 py-2 text-left text-xs transition-colors",
        active
          ? "bg-bg-panel text-ink shadow-[inset_3px_0_0_rgb(var(--color-accent))]"
          : "text-ink-dim hover:bg-bg-panel/60 hover:text-ink",
      )}
    >
      <span className="pt-0.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={disabled}
          aria-label={`Select ${conversation.title}`}
          className="h-3.5 w-3.5 accent-accent disabled:opacity-50"
        />
      </span>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="min-w-0 text-left disabled:opacity-60"
      >
        <span className="block truncate font-medium">{conversation.title}</span>
        <span className="block truncate font-mono text-[10px] text-ink-faint">
          {conversation.messages.length} messages ·{" "}
          {new Date(conversation.updated).toLocaleString()}
        </span>
      </button>
    </div>
  );
}

function MessageBubble({ message }: { message: PublicMessage }) {
  const Icon =
    message.role === "user" ? UserRound : message.role === "assistant" ? Bot : LockKeyhole;
  const label =
    message.role === "user" ? "you" : message.role === "assistant" ? "clio" : "system";

  return (
    <article
      className={cx(
        "chat-message rounded-md border px-5 py-4 text-[15px] leading-relaxed shadow-[inset_0_1px_0_rgb(255_255_255_/_0.03)]",
        message.role === "user" && "chat-message-user",
        message.role === "assistant" && "chat-message-assistant",
        message.role === "system" && "chat-message-system",
      )}
    >
      <header className="mb-2 flex items-center gap-2 text-[11.5px] text-ink-faint">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono uppercase tracking-widest">
            {label}
          </span>
          <span className="shrink-0 font-mono">{message.ts}</span>
        </div>
      </header>
      <div className="prose prose-theme max-w-none text-sm">
        <MarkdownContent content={message.content} />
      </div>
      <div className="mt-2 flex justify-end">
        <MessageCopyButton
          content={message.content}
          copyLabel="Copy message"
          copiedLabel="Copied"
        />
      </div>
    </article>
  );
}
