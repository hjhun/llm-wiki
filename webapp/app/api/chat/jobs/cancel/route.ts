import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { getChatJob } from "@/lib/chat-jobs";
import { requestStopFlag } from "@/lib/ingest-loop";

export const dynamic = "force-dynamic";

/**
 * Cancels a running chat job. The semantics depend on the job kind:
 *
 *   - "ingest-loop" uses the existing file-based stop flag so the loop
 *     halts gracefully *between* sub-chunks; the in-flight CLI keeps
 *     running so partial progress is preserved. This matches the
 *     /ingest-loop/stop route's behavior — we redirect there transparently
 *     so the UI can use a single "Cancel" affordance.
 *   - Every other kind (chat, ingest, preprocess, query, lint, graph)
 *     gets an immediate SIGTERM via the job's AbortController. runCli
 *     wires that signal through to the child process.
 *
 * Idempotent. If the job has already finished, returns ok=true with a
 * note explaining nothing changed.
 */
const Body = z.object({
  jobId: z.string().min(1),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("jobId required", 400);

  const job = getChatJob(parsed.data.jobId);
  if (!job) return jsonError("job not found", 404);

  try {
    if (job.kind === "ingest-loop") {
      await requestStopFlag(job.sessionPath);
      return NextResponse.json({
        ok: true,
        kind: "graceful",
        note: "ingest-loop는 현재 sub-chunk가 끝나면 중단됩니다.",
      });
    }
    job.cancel();
    return NextResponse.json({
      ok: true,
      kind: "immediate",
      note: "CLI 프로세스에 SIGTERM 전송 요청.",
    });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
