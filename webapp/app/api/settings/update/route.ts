import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { readReleaseInfo, runReleaseUpdate } from "@/lib/update";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;

  try {
    return NextResponse.json(await readReleaseInfo());
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}

export async function POST() {
  const unauth = await requireSession();
  if (unauth) return unauth;

  try {
    const result = await runReleaseUpdate();
    const status = result.exitCode === 0 ? 200 : 500;
    return NextResponse.json(result, { status });
  } catch (err) {
    const message = errorMessage(err);
    return jsonError(message, message.includes("already running") ? 409 : 500);
  }
}
