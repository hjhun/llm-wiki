import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, isFirstRun, verifySessionToken } from "@/lib/auth";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (await isFirstRun()) {
    redirect("/setup");
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (!session) {
    redirect("/login");
  }
  const cfg = await loadConfig();
  redirect(`/${cfg.ui.defaultTab}`);
}
