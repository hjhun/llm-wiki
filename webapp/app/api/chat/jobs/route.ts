import { NextResponse } from "next/server";
import { requireSession } from "@/lib/api";
import { listRunningChatJobs } from "@/lib/chat-jobs";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;
  return NextResponse.json({ jobs: listRunningChatJobs() });
}
