"use client";

import { useEffect, useState } from "react";
import type { ChatJobSnapshot } from "@/lib/chat-events";

const POLL_INTERVAL_MS = 2500;

export type RunningJobsState = {
  running: boolean;
  jobs: ChatJobSnapshot[];
};

/**
 * Polls the server-side chat job store so any tab can tell whether a coding
 * agent is currently running. Mirrors Chat.refreshRunningJobs(), but on a
 * fixed interval and paused while the document is hidden so background tabs
 * stop hitting the endpoint.
 */
export function useRunningJobs(): RunningJobsState {
  const [jobs, setJobs] = useState<ChatJobSnapshot[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        const res = await fetch("/api/chat/jobs", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { jobs?: ChatJobSnapshot[] };
        if (!cancelled) setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      } catch {
        // Network blips are non-fatal: keep the last known state.
      }
    }

    function start() {
      if (timer != null) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    }

    function stop() {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") stop();
      else start();
    }

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { running: jobs.length > 0, jobs };
}
