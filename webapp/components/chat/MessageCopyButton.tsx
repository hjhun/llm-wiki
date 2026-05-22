"use client";

import { useEffect, useState } from "react";
import { Clipboard, ClipboardCheck } from "lucide-react";
import { writeClipboard } from "./clipboard";

export default function MessageCopyButton({
  content,
  copyLabel,
  copiedLabel,
}: {
  content: string;
  copyLabel: string;
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
      className={[
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border bg-bg-panel shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50",
        copied
          ? "border-success/50 text-success"
          : "border-accent/40 text-accent hover:border-accent hover:bg-accent/15",
      ].join(" ")}
      title={copied ? copiedLabel : copyLabel}
      aria-label={copied ? copiedLabel : copyLabel}
      disabled={!content}
      onClick={() => void copyMessage()}
    >
      {copied ? (
        <ClipboardCheck aria-hidden className="h-3.5 w-3.5" />
      ) : (
        <Clipboard aria-hidden className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
