import { requireSession } from "@/lib/api";
import {
  getAutoLintEvents,
  type AutoLintEvent,
} from "@/lib/auto-lint/events";
import { readRuntimeState } from "@/lib/auto-lint/runtime-state";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

/**
 * Long-lived SSE stream that pushes auto-lint start/done/skipped/suggestion/
 * state events. Subscribers: the AutoLintPanel in Settings, the global badge
 * in Sidebar, and the AutoLintHint above the chat Composer.
 */
export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const bus = getAutoLintEvents();
  let abortHandler: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let listener: ((event: AutoLintEvent) => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // controller may have been closed by the client
        }
      };
      const sendEvent = (event: AutoLintEvent) => {
        write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const sendComment = (text: string) => {
        write(`: ${text}\n\n`);
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

      const initial = await readRuntimeState();
      sendEvent({ type: "state", state: initial });

      listener = (event: AutoLintEvent) => sendEvent(event);
      bus.on("event", listener);

      heartbeat = setInterval(() => sendComment("ping"), 25_000);

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
