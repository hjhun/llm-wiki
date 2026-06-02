"use client";

import MarkdownContent from "../chat/MarkdownContent";
import { useLanguage } from "../i18n";

type MarkdownPreviewProps = {
  content: string;
  className?: string;
};

/**
 * Explorer markdown preview. Delegates to the shared MarkdownContent renderer
 * so wiki previews get the same syntax highlighting, callouts, wikilink chips,
 * tables, and Mermaid toolbar as chat answers (single source of truth).
 */
export default function MarkdownPreview({
  content,
  className,
}: MarkdownPreviewProps) {
  const { t } = useLanguage();
  return (
    <div className={className}>
      <MarkdownContent content={content} toc tocLabel={t.common.tableOfContents} />
    </div>
  );
}
