import { LanguageProvider } from "@/components/i18n";
import PublicClioChat from "@/components/public-clio/PublicClioChat";
import { ThemeProvider } from "@/components/theme";
import { BRAND_NAME } from "@/lib/branding";
import { loadConfig } from "@/lib/config";

export default async function PublicClioEntry() {
  const cfg = await loadConfig();
  const isKorean = cfg.ui.language === "ko";

  return (
    <ThemeProvider initialTheme={cfg.ui.theme}>
      <LanguageProvider initialLanguage={cfg.ui.language}>
        {cfg.publicQuery.enabled ? (
          <PublicClioChat appSubtitle={cfg.ui.appSubtitle} />
        ) : (
          <main className="flex h-screen w-screen items-center justify-center bg-bg px-6 text-ink">
            <section className="w-full max-w-lg rounded-md border border-line bg-bg-panel/82 p-6 shadow-sm backdrop-blur-xl">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                {BRAND_NAME}
              </div>
              {cfg.ui.appSubtitle ? (
                <div className="mt-1 text-xs font-medium text-ink-dim">
                  {cfg.ui.appSubtitle}
                </div>
              ) : null}
              <h1 className="mt-2 text-lg font-semibold text-ink">
                {isKorean ? "공개 query가 꺼져 있습니다" : "Public query is disabled"}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">
                {isKorean
                  ? "관리자가 Settings > Access에서 비밀번호 없는 /clio 공유를 켜면 이 주소에서 query-only 채팅을 사용할 수 있습니다."
                  : "An administrator can enable passwordless /clio sharing from Settings > Access to make this query-only chat available."}
              </p>
            </section>
          </main>
        )}
      </LanguageProvider>
    </ThemeProvider>
  );
}
