import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { runGraphify } from "@/lib/graph";

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
    const result = await runGraphify(parsed.data.action);
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
