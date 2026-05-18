import { requireSession } from "@/lib/api";
import {
  getAutomationEvents,
  type AutomationEvent,
} from "@/lib/automation/events";
import { readAutomationRuntime } from "@/lib/automation/runtime-state";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const bus = getAutomationEvents();
  let abortHandler: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let listener: ((event: AutomationEvent) => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // client closed
        }
      };
      const sendEvent = (event: AutomationEvent) => {
        write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (listener) bus.off("event", listener);
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      sendEvent({ type: "state", state: await readAutomationRuntime() });
      listener = (event: AutomationEvent) => sendEvent(event);
      bus.on("event", listener);
      heartbeat = setInterval(() => write(": ping\n\n"), 25_000);
      abortHandler = () => close();
      req.signal.addEventListener("abort", abortHandler);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
