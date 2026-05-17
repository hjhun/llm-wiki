import { redirect } from "next/navigation";
import AuthCard from "@/components/AuthCard";
import { isFirstRun } from "@/lib/auth";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!(await isFirstRun())) {
    redirect("/login");
  }
  const cfg = await loadConfig();
  return (
    <AuthCard mode="setup" language={cfg.ui.language} theme={cfg.ui.theme} />
  );
}
