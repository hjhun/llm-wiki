import { LanguageProvider } from "@/components/i18n";
import PublicClioChat from "@/components/public-clio/PublicClioChat";
import { ThemeProvider } from "@/components/theme";
import { BRAND_NAME } from "@/lib/branding";
import { loadConfig } from "@/lib/config";
import { normalizeLanguage, publicClioDisabledText } from "@/lib/i18n";

export default async function PublicClioEntry() {
  const cfg = await loadConfig();
  const disabledText = publicClioDisabledText(normalizeLanguage(cfg.ui.language));

  return (
    <ThemeProvider initialTheme={cfg.ui.theme}>
      <LanguageProvider initialLanguage={cfg.ui.language}>
        {cfg.publicQuery.enabled ? (
          <PublicClioChat
            appSubtitle={cfg.ui.appSubtitle}
            accessRequired={
              typeof cfg.publicQuery.accessToken === "string" &&
              cfg.publicQuery.accessToken.length > 0
            }
          />
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
                {disabledText.title}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">
                {disabledText.description}
              </p>
            </section>
          </main>
        )}
      </LanguageProvider>
    </ThemeProvider>
  );
}
