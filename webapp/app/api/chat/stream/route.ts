import { requireSession, jsonError } from "@/lib/api";
import { createChatJobStream, getChatJob } from "@/lib/chat-jobs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) return jsonError("jobId required", 400);

  const job = getChatJob(jobId);
  if (!job) return jsonError("job not found", 404);

  const afterRaw = searchParams.get("after");
  const after = afterRaw == null ? -1 : Number.parseInt(afterRaw, 10);
  const afterSeq = Number.isFinite(after) ? after : -1;

  const stream = createChatJobStream(job, {
    signal: req.signal,
    afterSeq,
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
