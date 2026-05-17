import { requireSession } from "@/lib/api";
import { getAutoIngestEvents, type AutoIngestEvent } from "@/lib/auto-ingest/events";
import { readRuntimeState } from "@/lib/auto-ingest/runtime-state";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

/**
 * Long-lived SSE stream that pushes auto-ingest start/done/skipped/state
 * events to subscribers (the Settings card and the Chat banner). The bus
 * lives in `lib/auto-ingest/events.ts` as a process-wide EventEmitter so
 * every active client receives the same events without polling.
 */
export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const bus = getAutoIngestEvents();
  let abortHandler: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let listener: ((event: AutoIngestEvent) => void) | null = null;

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
      const sendEvent = (event: AutoIngestEvent) => {
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

      // Send current state immediately so the client has something to render.
      const initial = await readRuntimeState();
      sendEvent({ type: "state", state: initial });

      listener = (event: AutoIngestEvent) => sendEvent(event);
      bus.on("event", listener);

      // Heartbeat keeps proxies and idle clients from killing the connection.
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
