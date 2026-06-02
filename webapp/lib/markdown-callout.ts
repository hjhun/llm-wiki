export type CalloutKind = "warning" | "info" | "danger";

/**
 * 인용문(blockquote)의 첫 줄을 보고 콜아웃 종류를 판별한다. CLAUDE.md 규약의
 * 모순 표기("> ⚠️ Conflicts with ...")를 포함해, 흔한 경고/정보/위험 표식과
 * 한국어 키워드를 인식한다. 해당 없으면 null(일반 인용문으로 렌더).
 */
export function detectCallout(firstLine: string): CalloutKind | null {
  const text = firstLine.trim();
  if (!text) return null;

  if (
    /^(?:❗|‼️|🚨|⛔)/u.test(text) ||
    /^danger\b/i.test(text) ||
    /위험/.test(text)
  ) {
    return "danger";
  }

  if (
    /^(?:⚠️|⚠)/u.test(text) ||
    /\bconflicts?\b/i.test(text) ||
    /^(?:warning|caution)\b/i.test(text) ||
    /주의|경고/.test(text)
  ) {
    return "warning";
  }

  if (
    /^(?:ℹ️|ℹ|💡|📝)/u.test(text) ||
    /^(?:note|info|tip)\b/i.test(text) ||
    /^참고/.test(text)
  ) {
    return "info";
  }

  return null;
}
