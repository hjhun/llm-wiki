import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { createChatJobStream } from "@/lib/chat-jobs";
import { startGraphifyJob } from "@/lib/graph";

export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["build", "update"]),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  try {
    // startGraphifyJob registers the job and detaches the CLI run; the NDJSON
    // stream below relays its start/chunk/done/error events to the Graph tab.
    // Closing this stream (navigating away) does not kill the run.
    const job = await startGraphifyJob(parsed.data.action);
    const stream = createChatJobStream(job, { signal: req.signal });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
