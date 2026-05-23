"use client";

import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Check,
  Code2,
  Copy,
  Clipboard,
  ClipboardCheck,
  Download,
  ExternalLink,
  Workflow,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { writeClipboard } from "./clipboard";

type MarkdownContentProps = {
  content: string;
  emptyText?: string;
  liveMermaid?: boolean;
};

type CodeElementProps = {
  className?: string;
  children?: ReactNode;
};

type CodeBlock = {
  className?: string;
  language: string | null;
  source: string;
};

type SvgSize = {
  width: number;
  height: number;
};

function createMarkdownComponents(liveMermaid: boolean): Components {
  return {
    a({ href, children, ...props }) {
      const isExplorerLink = href?.startsWith("/explorer?");
      if (isExplorerLink) {
        return (
          <a
            href={href}
            className="not-prose inline-flex max-w-full items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 align-baseline font-mono text-[11px] text-accent no-underline hover:border-accent hover:bg-accent/15"
            {...props}
          >
            <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
            <span className="truncate">{children}</span>
          </a>
        );
      }
      return (
        <a href={href} {...props}>
          {children}
        </a>
      );
    },
    pre({ children }) {
      const block = parseCodeBlock(children);
      if (!block) {
        return <pre>{children}</pre>;
      }

      if (block.language === "mermaid") {
        return <MermaidDiagram source={block.source} live={liveMermaid} />;
      }

      return <CopyableCodeBlock block={block} />;
    },
    code({ className, children, node: _node, ...props }) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };
}

export default function MarkdownContent({
  content,
  emptyText,
  liveMermaid = false,
}: MarkdownContentProps) {
  const components = useMemo(
    () => createMarkdownComponents(liveMermaid),
    [liveMermaid],
  );

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content || emptyText || ""}
    </ReactMarkdown>
  );
}

function parseCodeBlock(children: ReactNode): CodeBlock | null {
  const child = Children.toArray(children).find(isValidElement) as
    | ReactElement<CodeElementProps>
    | undefined;
  if (!child || child.type !== "code") return null;

  const className =
    typeof child.props.className === "string" ? child.props.className : "";
  const language = /language-([\w-]+)/.exec(className)?.[1]?.toLowerCase() ?? null;
  const source = Children.toArray(child.props.children).join("").replace(/\n$/, "");

  return { className, language, source };
}

function CopyableCodeBlock({ block }: { block: CodeBlock }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyCode() {
    await writeClipboard(block.source);
    setCopied(true);
  }

  const copyLabel = copied ? "Copied code" : "Copy code";

  return (
    <div className="not-prose relative my-4 overflow-hidden rounded-md border border-line bg-bg-subtle shadow-sm">
      <span className="pointer-events-none absolute left-3 top-2 z-10 max-w-[calc(100%-5rem)] truncate rounded border border-line bg-bg-panel/90 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint shadow-sm backdrop-blur">
        {block.language ?? "code"}
      </span>
      <button
        type="button"
        onClick={() => void copyCode()}
        title={copyLabel}
        aria-label={copyLabel}
        className={[
          "absolute right-2 top-2 z-10 inline-flex h-7 shrink-0 items-center gap-1.5 rounded border bg-bg-panel/90 px-2 font-mono text-[10px] font-medium uppercase tracking-wide shadow-sm backdrop-blur transition",
          copied
            ? "border-success/50 text-success"
            : "border-accent/40 text-accent hover:border-accent hover:bg-accent/15",
        ].join(" ")}
      >
        {copied ? (
          <ClipboardCheck aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <Clipboard aria-hidden className="h-3.5 w-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="m-0 max-h-[32rem] overflow-auto bg-transparent px-3 pb-3 pt-12 text-[12px] leading-relaxed">
        <code className={block.className}>{block.source}</code>
      </pre>
    </div>
  );
}

function MermaidDiagram({
  source,
  live = false,
}: {
  source: string;
  live?: boolean;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"diagram" | "source">("diagram");
  const [copied, setCopied] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const idRef = useRef<string | null>(null);
  const renderCountRef = useRef(0);
  const renderTokenRef = useRef(0);

  if (!idRef.current) {
    idRef.current = `chat-mermaid-${Math.random().toString(36).slice(2)}`;
  }

  useEffect(() => {
    let cancelled = false;
    const renderToken = renderTokenRef.current + 1;
    renderTokenRef.current = renderToken;

    if (!source.trim()) {
      setSvg(null);
      setError(null);
      setRendering(false);
      return;
    }

    setRendering(true);
    setError(null);
    if (!live) {
      setSvg(null);
    }

    async function renderDiagram() {
      try {
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
        if (!cancelled && renderTokenRef.current === renderToken) {
          setSvg(result.svg);
          setError(null);
          setDownloadError(null);
        }
      } catch (err) {
        if (!cancelled && renderTokenRef.current === renderToken) {
          if (!live) {
            setSvg(null);
          }
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled && renderTokenRef.current === renderToken) {
          setRendering(false);
        }
      }
    }

    const timer = window.setTimeout(() => {
      void renderDiagram();
    }, live ? 180 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, live]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copySource() {
    await writeClipboard(source);
    setCopied(true);
  }

  function downloadSvg() {
    if (!svg) return;
    setDownloadError(null);
    downloadBlob(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
      "mermaid-diagram.svg",
    );
  }

  async function downloadPng() {
    if (!svg) return;
    try {
      setDownloadError(null);
      const blob = await svgToPngBlob(svg);
      downloadBlob(blob, "mermaid-diagram.png");
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  }

  const toolbar = (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-b border-line bg-bg-panel/74 px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Workflow aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          mermaid
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <div className="flex overflow-hidden rounded border border-line bg-bg-subtle">
          <button
            type="button"
            onClick={() => setMode("diagram")}
            aria-pressed={mode === "diagram"}
            className={[
              "inline-flex h-7 items-center gap-1.5 border-r border-line px-2 font-mono text-[10px] font-medium uppercase tracking-wide transition",
              mode === "diagram"
                ? "bg-accent/12 text-ink"
                : "text-ink-dim hover:bg-bg-panel hover:text-ink",
            ].join(" ")}
          >
            <Workflow aria-hidden className="h-3.5 w-3.5" />
            Diagram
          </button>
          <button
            type="button"
            onClick={() => setMode("source")}
            aria-pressed={mode === "source"}
            className={[
              "inline-flex h-7 items-center gap-1.5 px-2 font-mono text-[10px] font-medium uppercase tracking-wide transition",
              mode === "source"
                ? "bg-accent/12 text-ink"
                : "text-ink-dim hover:bg-bg-panel hover:text-ink",
            ].join(" ")}
          >
            <Code2 aria-hidden className="h-3.5 w-3.5" />
            Source
          </button>
        </div>
        <div className="flex overflow-hidden rounded border border-line bg-bg-subtle">
          <button
            type="button"
            onClick={downloadSvg}
            disabled={!svg}
            title="Download SVG"
            className="inline-flex h-7 items-center gap-1.5 border-r border-line px-2 font-mono text-[10px] font-medium uppercase tracking-wide text-ink-dim transition hover:bg-bg-panel hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download aria-hidden className="h-3.5 w-3.5" />
            SVG
          </button>
          <button
            type="button"
            onClick={() => void downloadPng()}
            disabled={!svg}
            title="Download PNG"
            className="inline-flex h-7 items-center gap-1.5 px-2 font-mono text-[10px] font-medium uppercase tracking-wide text-ink-dim transition hover:bg-bg-panel hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download aria-hidden className="h-3.5 w-3.5" />
            PNG
          </button>
        </div>
        <button
          type="button"
          onClick={() => void copySource()}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded border border-line bg-bg-subtle px-2 font-mono text-[10px] font-medium uppercase tracking-wide text-ink-dim transition hover:border-accent/60 hover:text-ink"
        >
          {copied ? (
            <Check aria-hidden className="h-3.5 w-3.5" />
          ) : (
            <Copy aria-hidden className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );

  const sourceView = (
    <pre className="m-0 max-h-[32rem] overflow-auto bg-transparent p-3 text-[12px] leading-relaxed">
      <code className="language-mermaid">{source}</code>
    </pre>
  );

  const downloadErrorView = downloadError ? (
    <div className="border-b border-red-900/60 px-3 py-2 text-xs text-red-300">
      Download failed: {downloadError}
    </div>
  ) : null;

  const liveRenderNotice =
    live && error ? (
      <div className="border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
        Waiting for complete Mermaid syntax...
      </div>
    ) : rendering && live ? (
      <div className="border-b border-info/40 bg-info/10 px-3 py-2 text-xs text-info">
        Updating Mermaid preview...
      </div>
    ) : null;

  if (error && (!live || !svg)) {
    return (
      <div
        className={[
          "not-prose my-4 overflow-hidden rounded-md shadow-sm",
          live
            ? "border border-line bg-bg-subtle"
            : "border border-red-900/60 bg-red-950/20",
        ].join(" ")}
      >
        {toolbar}
        {live ? (
          <div className="border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            Waiting for complete Mermaid syntax...
          </div>
        ) : (
          <div className="border-b border-red-900/60 px-3 py-2 text-xs text-red-300">
            Mermaid render failed: {error}
          </div>
        )}
        {sourceView}
      </div>
    );
  }

  if (mode === "source") {
    return (
      <div className="not-prose my-4 overflow-hidden rounded-md border border-line bg-bg-subtle shadow-sm">
        {toolbar}
        {downloadErrorView}
        {sourceView}
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="not-prose my-4 overflow-hidden rounded-md border border-line bg-bg-subtle shadow-sm">
        {toolbar}
        {downloadErrorView}
        {liveRenderNotice}
        <div className="px-3 py-2 text-xs text-ink-faint">
          {live ? "Waiting for Mermaid content..." : "Rendering Mermaid diagram..."}
        </div>
      </div>
    );
  }

  return (
    <div className="not-prose my-4 overflow-hidden rounded-md border border-line bg-bg-subtle shadow-sm">
      {toolbar}
      {downloadErrorView}
      {liveRenderNotice}
      <div
        className="overflow-auto p-3 [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function svgToPngBlob(svg: string): Promise<Blob> {
  const size = getSvgSize(svg);
  const imageUrl = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
  );

  try {
    const image = await loadImage(imageUrl);
    const scale = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(size.width * scale);
    canvas.height = Math.ceil(size.height * scale);

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas is not available in this browser.");
    }

    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.drawImage(image, 0, 0, size.width, size.height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) {
          resolve(result);
          return;
        }
        reject(new Error("Browser could not export the diagram as PNG."));
      }, "image/png");
    });

    return blob;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Browser could not load the SVG."));
    image.src = src;
  });
}

function getSvgSize(svg: string): SvgSize {
  const fallback = { width: 1200, height: 800 };
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return fallback;

  const width = parseSvgLength(root.getAttribute("width"));
  const height = parseSvgLength(root.getAttribute("height"));
  if (width && height) return { width, height };

  const viewBox = root.getAttribute("viewBox")?.trim();
  if (!viewBox) return fallback;

  const parts = viewBox.split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return fallback;
  }

  const [, , viewBoxWidth, viewBoxHeight] = parts;
  if (viewBoxWidth <= 0 || viewBoxHeight <= 0) return fallback;
  return { width: viewBoxWidth, height: viewBoxHeight };
}

function parseSvgLength(value: string | null): number | null {
  if (!value) return null;
  const match = /^([0-9.]+)/.exec(value.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
