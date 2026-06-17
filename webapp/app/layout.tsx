import type { Metadata } from "next";
import { formatBrandTitle } from "@/lib/branding";
import { loadConfig } from "@/lib/config";
import { appDescription, normalizeLanguage } from "@/lib/i18n";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await loadConfig();
  const language = normalizeLanguage(cfg.ui.language);
  return {
    title: formatBrandTitle(cfg.ui.appSubtitle),
    description: appDescription(language),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cfg = await loadConfig();
  const language = normalizeLanguage(cfg.ui.language);
  return (
    <html lang={language}>
      <body className="h-screen w-screen overflow-hidden">{children}</body>
    </html>
  );
}
