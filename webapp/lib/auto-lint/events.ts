import { EventEmitter } from "node:events";
import type { AutoLintRuntime } from "./runtime-state";

export type AutoLintSource = "cron" | "manual";

export type AutoLintEvent =
  | { type: "start"; source: AutoLintSource; startedAt: string }
  | {
      type: "done";
      source: AutoLintSource;
      halt: "normal" | "error" | "skipped" | "noop";
      reason: string;
      durationMs: number;
      sessionPath: string | null;
      reportPath: string | null;
    }
  | { type: "skipped"; source: AutoLintSource; reason: string }
  | { type: "suggestion"; count: number; threshold: number }
  | { type: "state"; state: AutoLintRuntime };

class AutoLintEventBus extends EventEmitter {
  emitEvent(event: AutoLintEvent): void {
    this.emit("event", event);
  }
}

const globalRef = globalThis as unknown as {
  __autoLintEventBus?: AutoLintEventBus;
};

export function getAutoLintEvents(): AutoLintEventBus {
  if (!globalRef.__autoLintEventBus) {
    const bus = new AutoLintEventBus();
    bus.setMaxListeners(50);
    globalRef.__autoLintEventBus = bus;
  }
  return globalRef.__autoLintEventBus;
}
