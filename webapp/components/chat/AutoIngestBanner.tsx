"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../i18n";

type AutoIngestEvent =
  | {
      type: "start";
      source: "watch" | "schedule" | "manual";
      startedAt: string;
    }
  | {
      type: "done";
      source: "watch" | "schedule" | "manual";
      halt:
        | "normal"
        | "error"
        | "stopped"
        | "capped"
        | "stalled"
        | "skipped"
        | "noop";
      reason: string;
      iterations: number;
      durationMs: number;
      anyProgress: boolean;
      sessionPath: string | null;
    }
  | {
      type: "skipped";
      source: "watch" | "schedule" | "manual";
      reason: string;
    }
  | { type: "state"; state: unknown };

type Banner =
  | { tone: "info"; text: string; transient: boolean }
  | { tone: "success"; text: string; transient: boolean }
  | { tone: "warn"; text: string; transient: boolean }
  | { tone: "error"; text: string; transient: boolean };

/**
 * Listens to the auto-ingest SSE stream and shows a slim banner at the top
 * of the chat tab when a background trigger starts, finishes, or skips. The
 * "running" banner stays sticky; start→done transitions clear it. Skipped /
 * done banners auto-hide after a few seconds so the chat does not get
 * cluttered.
 */
export default function AutoIngestBanner() {
  const { t } = useLanguage();
  const [banner, setBanner] = useState<Banner | null>(null);
  const hideTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/auto-ingest/events");
    const setBannerWithTimer = (next: Banner) => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setBanner(next);
      if (next.transient) {
        hideTimer.current = setTimeout(() => {
          setBanner(null);
          hideTimer.current = null;
        }, 7000);
      }
    };
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as AutoIngestEvent;
        if (event.type === "start") {
          setBannerWithTimer({
            tone: "info",
            text: t.settings.autoIngestBannerRunning(event.source),
            transient: false,
          });
        } else if (event.type === "done") {
          setBannerWithTimer({
            tone: event.halt === "error" ? "error" : "success",
            text: t.settings.autoIngestBannerDone(event.halt, event.iterations),
            transient: true,
          });
        } else if (event.type === "skipped") {
          setBannerWithTimer({
            tone: "warn",
            text: t.settings.autoIngestBannerSkipped(event.reason),
            transient: true,
          });
        }
      } catch {
        // ignore malformed events
      }
    };
    es.onerror = () => {
      // The browser auto-reconnects; nothing for us to do here.
    };
    return () => {
      es.close();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [t.settings]);

  if (!banner) return null;
  const tone =
    banner.tone === "info"
      ? "border-amber-900/60 bg-amber-950/40 text-amber-200"
      : banner.tone === "success"
        ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-200"
        : banner.tone === "warn"
          ? "border-yellow-900/60 bg-yellow-950/40 text-yellow-200"
          : "border-red-900/60 bg-red-950/40 text-red-300";
  return (
    <div className={`border-b px-4 py-1 text-[11px] ${tone}`}>{banner.text}</div>
  );
}
