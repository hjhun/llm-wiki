export const SUPPORTED_LANGUAGES = ["ko", "en"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export type LanguageOption = {
  code: Language;
  nativeName: string;
  englishName: string;
  locale: string;
};

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { code: "ko", nativeName: "한국어", englishName: "Korean", locale: "ko-KR" },
  { code: "en", nativeName: "English", englishName: "English", locale: "en-US" },
] as const;

export const DEFAULT_LANGUAGE: Language = "ko";

const LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGES);

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && LANGUAGE_SET.has(value);
}

export function normalizeLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

export function localeForLanguage(language: Language): string {
  return LANGUAGE_OPTIONS.find((option) => option.code === language)?.locale ?? "en-US";
}

export function nextLanguage(language: Language): Language {
  const index = SUPPORTED_LANGUAGES.indexOf(language);
  return SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length] ?? DEFAULT_LANGUAGE;
}

export function appDescription(language: Language): string {
  if (language === "ko") {
    return "CLIO - LLM WIKI: 개인 지식베이스를 채팅, 탐색, 그래프, 설정 화면으로 관리합니다.";
  }
  return "CLIO - LLM WIKI: chat, explore, graph and configure your personal knowledge base.";
}

export function publicClioDisabledText(language: Language): {
  title: string;
  description: string;
} {
  if (language === "ko") {
    return {
      title: "공개 query가 꺼져 있습니다",
      description:
        "관리자가 Settings > Access에서 비밀번호 없는 /clio 공유를 켜면 이 주소에서 query-only 채팅을 사용할 수 있습니다.",
    };
  }
  return {
    title: "Public query is disabled",
    description:
      "An administrator can enable passwordless /clio sharing from Settings > Access to make this query-only chat available.",
  };
}

export function formatDateTime(
  value: string | number | Date | null | undefined,
  language: Language,
): string {
  if (value == null || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(localeForLanguage(language), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatNumber(value: number, language: Language): string {
  return new Intl.NumberFormat(localeForLanguage(language)).format(value);
}
