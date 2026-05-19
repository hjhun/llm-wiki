import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { saveChatCapture } from "@/lib/chat-captures";

const Body = z.object({
  sessionPath: z.string().min(1),
  messageIndex: z.number().int().min(0),
  title: z.string().min(1).max(120).optional(),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  try {
    const capture = await saveChatCapture(parsed.data);
    return NextResponse.json(capture);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
