"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeClipboard } from "./clipboard";

export default function MessageCopyButton({
  content,
  copyLabel,
  copyText,
  copiedLabel,
}: {
  content: string;
  copyLabel: string;
  copyText: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyMessage() {
    await writeClipboard(content);
    setCopied(true);
  }

  return (
    <button
      type="button"
      className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded border border-line bg-bg-subtle px-2 text-[11px] font-medium text-ink-muted transition hover:border-accent/60 hover:bg-bg-panel hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      title={copied ? copiedLabel : copyLabel}
      aria-label={copied ? copiedLabel : copyLabel}
      disabled={!content}
      onClick={() => void copyMessage()}
    >
      {copied ? (
        <Check aria-hidden className="h-3.5 w-3.5" />
      ) : (
        <Copy aria-hidden className="h-3.5 w-3.5" />
      )}
      <span>{copied ? copiedLabel : copyText}</span>
    </button>
  );
}
