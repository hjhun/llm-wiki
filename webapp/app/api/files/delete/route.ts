import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { deleteEntries } from "@/lib/files";

const Body = z
  .object({
    ws: z.enum(["wiki", "raw", "sessions"]),
    path: z.string().min(1).optional(),
    paths: z.array(z.string().min(1)).optional(),
  })
  .refine((body) => Boolean(body.path || body.paths?.length), {
    message: "path or paths is required",
  });

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  try {
    const paths = parsed.data.paths ??
      (parsed.data.path ? [parsed.data.path] : []);
    const result = await deleteEntries(parsed.data.ws, paths);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
