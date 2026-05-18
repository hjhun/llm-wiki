"use client";

import { Children, useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownPreviewProps = {
  content: string;
  className?: string;
};

type MermaidDiagramProps = {
  source: string;
};

const markdownComponents: Components = {
  code({ className, children, node: _node, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const language = match?.[1]?.toLowerCase();
    const source = Children.toArray(children).join("").replace(/\n$/, "");

    if (language === "mermaid") {
      return <MermaidDiagram source={source} />;
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export default function MarkdownPreview({
  content,
  className,
}: MarkdownPreviewProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MermaidDiagram({ source }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const renderCountRef = useRef(0);

  if (!idRef.current) {
    idRef.current = `mermaid-${Math.random().toString(36).slice(2)}`;
  }

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        setSvg(null);
        setError(null);
        const mermaid = (await import("mermaid")).default;
        const theme =
          document.documentElement.dataset.theme === "dark" ? "dark" : "default";

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme,
        });

        renderCountRef.current += 1;
        const result = await mermaid.render(
          `${idRef.current}-${renderCountRef.current}`,
          source,
        );
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSvg(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="not-prose my-4 overflow-hidden rounded border border-red-900/60 bg-red-950/20">
        <div className="border-b border-red-900/60 px-3 py-2 text-xs text-red-300">
          Mermaid render failed: {error}
        </div>
        <pre className="overflow-auto p-3 text-[11px] leading-relaxed text-ink-dim">
          {source}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="not-prose my-4 rounded border border-line bg-bg-subtle px-3 py-2 text-xs text-ink-faint">
        Rendering Mermaid diagram...
      </div>
    );
  }

  return (
    <div
      className="not-prose my-4 overflow-auto rounded border border-line bg-bg-subtle p-3 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
