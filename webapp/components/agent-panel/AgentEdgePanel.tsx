"use client";

import { useState } from "react";
import AgentMascot from "./AgentMascot";
import { useRunningJobs } from "./useRunningJobs";
import { useLanguage } from "../i18n";

/**
 * Ambient, hover-revealed edge tab. It sits flush against the right screen
 * edge on every authenticated page; hovering (or focusing/clicking) the tab
 * slides out a panel that shows an animated mascot. The mascot is calm while
 * idle and animates energetically while a coding agent is running, so agent
 * activity reads as a little character hard at work.
 */
export default function AgentEdgePanel() {
  const { t } = useLanguage();
  const ap = t.agentPanel;
  const [open, setOpen] = useState(false);
  const { running, jobs } = useRunningJobs();

  const caption = running ? ap.running : ap.idle;
  let hint: string = ap.idleHint;
  if (running) {
    const kinds = Array.from(new Set(jobs.map((job) => job.kind)));
    hint =
      jobs.length > 1 ? ap.jobsRunning(jobs.length) : ap.jobLabel(kinds[0] ?? "");
  }

  return (
    <div
      className="agent-edge-panel fixed right-0 top-1/2 z-40 flex"
      data-open={open ? "true" : "false"}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="agent-edge-tab"
        data-running={running ? "true" : "false"}
        aria-expanded={open}
        aria-label={open ? ap.closeLabel : ap.openLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-edge-tab-dot" />
        <span className="agent-edge-tab-label">{ap.tabLabel}</span>
      </button>

      <div className="agent-edge-body">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            {ap.title}
          </span>
          <span
            className={[
              "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest",
              running ? "text-accent" : "text-ink-faint",
            ].join(" ")}
          >
            <span
              className={[
                "h-1.5 w-1.5 rounded-full",
                running ? "bg-accent" : "bg-ink-faint",
              ].join(" ")}
            />
            {caption}
          </span>
        </div>

        <AgentMascot running={running} />

        <div className="mt-3 text-center">
          <div className="text-[13px] font-semibold text-ink">{caption}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-ink-dim">
            {hint}
          </div>
        </div>
      </div>
    </div>
  );
}
