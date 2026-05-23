import type { Metadata } from "next";
import { formatBrandTitle } from "@/lib/branding";
import { loadConfig } from "@/lib/config";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await loadConfig();
  return {
    title: formatBrandTitle(cfg.ui.appSubtitle),
    description:
      "CLIO - LLM WIKI: chat, explore, graph and configure your personal knowledge base.",
  };
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="h-screen w-screen overflow-hidden">{children}</body>
    </html>
  );
}
