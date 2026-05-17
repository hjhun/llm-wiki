import { EventEmitter } from "node:events";
import type { AutoIngestRuntime } from "./runtime-state";

export type AutoIngestEvent =
  | { type: "start"; source: "watch" | "schedule" | "manual"; startedAt: string }
  | {
      type: "done";
      source: "watch" | "schedule" | "manual";
      halt: "normal" | "error" | "stopped" | "capped" | "skipped" | "noop";
      reason: string;
      iterations: number;
      durationMs: number;
      anyProgress: boolean;
      sessionPath: string | null;
    }
  | { type: "skipped"; source: "watch" | "schedule" | "manual"; reason: string }
  | { type: "state"; state: AutoIngestRuntime };

class AutoIngestEventBus extends EventEmitter {
  emitEvent(event: AutoIngestEvent): void {
    this.emit("event", event);
  }
}

const globalRef = globalThis as unknown as {
  __autoIngestEventBus?: AutoIngestEventBus;
};

export function getAutoIngestEvents(): AutoIngestEventBus {
  if (!globalRef.__autoIngestEventBus) {
    const bus = new AutoIngestEventBus();
    bus.setMaxListeners(50);
    globalRef.__autoIngestEventBus = bus;
  }
  return globalRef.__autoIngestEventBus;
}
