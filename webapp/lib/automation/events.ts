import { EventEmitter } from "node:events";
import type { AutomationRunResult } from "./types";
import type { AutomationRuntime } from "./runtime-state";

export type AutomationEvent =
  | { type: "start"; jobId: string; runId: string; source: string; mode: "plan" | "run"; startedAt: string }
  | { type: "output"; jobId: string; runId: string; agent: string; text: string }
  | { type: "done"; result: AutomationRunResult }
  | { type: "skipped"; jobId: string; reason: string }
  | { type: "state"; state: AutomationRuntime };

class AutomationEventBus extends EventEmitter {
  emitEvent(event: AutomationEvent): void {
    this.emit("event", event);
  }
}

const globalRef = globalThis as unknown as {
  __automationEventBus?: AutomationEventBus;
};

export function getAutomationEvents(): AutomationEventBus {
  if (!globalRef.__automationEventBus) {
    const bus = new AutomationEventBus();
    bus.setMaxListeners(80);
    globalRef.__automationEventBus = bus;
  }
  return globalRef.__automationEventBus;
}
