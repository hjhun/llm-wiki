"use client";

import MarkdownContent from "../chat/MarkdownContent";

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
  return (
    <div className={className}>
      <MarkdownContent content={content} />
    </div>
  );
}
