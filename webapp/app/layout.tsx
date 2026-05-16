import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLM Wiki",
  description:
    "Local LLM Wiki — chat, explore, graph and configure your personal knowledge base.",
};

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
