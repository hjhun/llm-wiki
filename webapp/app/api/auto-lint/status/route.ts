import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { readRuntimeState } from "@/lib/auto-lint/runtime-state";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;
  try {
    const [cfg, runtime] = await Promise.all([
      loadConfig(),
      readRuntimeState(),
    ]);
    return NextResponse.json({
      config: cfg.autoLint,
      runtime,
    });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
