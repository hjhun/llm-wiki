import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { getChatJob } from "@/lib/chat-jobs";
import { requestStopFlag } from "@/lib/ingest-loop";

export const dynamic = "force-dynamic";

/**
 * Cancels a running chat job immediately. All job kinds get a SIGTERM through
 * the job AbortController. ingest-loop also receives the legacy stop flag so
 * any loop boundary that is reached before SIGTERM lands stops cleanly.
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
    // Both /ingest and /ingest-loop run through the runIngestLoop backend loop,
    // so both need the stop flag: it halts the loop at the next boundary and,
    // crucially, stops the per-iteration retry from re-spawning the CLI after
    // the SIGTERM lands. (job.cancel() SIGTERMs the live child immediately.)
    if (job.kind === "ingest" || job.kind === "ingest-loop") {
      await requestStopFlag(job.sessionPath);
    }
    job.cancel();
    return NextResponse.json({
      ok: true,
      kind: "immediate",
      note: "실행 중인 CLI 프로세스에 SIGTERM 전송 요청.",
    });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
