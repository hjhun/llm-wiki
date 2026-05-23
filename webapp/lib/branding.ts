export const BRAND_NAME = "CLIO - LLM WIKI";

export function formatBrandTitle(appSubtitle: string | null | undefined) {
  const subtitle = appSubtitle?.trim();
  return subtitle ? `${BRAND_NAME} | ${subtitle}` : BRAND_NAME;
}
