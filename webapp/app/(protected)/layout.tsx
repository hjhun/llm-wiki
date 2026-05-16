import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { SESSION_COOKIE, isFirstRun, verifySessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await isFirstRun()) {
    redirect("/setup");
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex h-screen flex-1 flex-col overflow-hidden bg-bg">
        {children}
      </main>
    </div>
  );
}
