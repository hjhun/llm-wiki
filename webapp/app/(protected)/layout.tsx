import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AgentEdgePanel from "@/components/agent-panel/AgentEdgePanel";
import CommandPalette from "@/components/CommandPalette";
import { LanguageProvider } from "@/components/i18n";
import Sidebar from "@/components/Sidebar";
import { ThemeProvider } from "@/components/theme";
import { ToastProvider } from "@/components/ui/Toast";
import { SESSION_COOKIE, isFirstRun, verifySessionToken } from "@/lib/auth";
import { loadConfig } from "@/lib/config";

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
  const cfg = await loadConfig();

  return (
    <ThemeProvider initialTheme={cfg.ui.theme}>
      <LanguageProvider initialLanguage={cfg.ui.language}>
        <ToastProvider>
          <div className="flex h-screen w-screen overflow-hidden">
            <Sidebar appSubtitle={cfg.ui.appSubtitle} />
            <main className="flex h-screen flex-1 flex-col overflow-hidden bg-bg/80">
              {children}
            </main>
          </div>
          {cfg.ui.agentEdgePanelEnabled ? <AgentEdgePanel /> : null}
          <CommandPalette />
        </ToastProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}
