import { redirect } from "next/navigation";
import AuthCard from "@/components/AuthCard";
import { isFirstRun } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!(await isFirstRun())) {
    redirect("/login");
  }
  return <AuthCard mode="setup" />;
}
