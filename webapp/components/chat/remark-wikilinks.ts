import { resolveWikilink } from "@/lib/wikilink";

/**
 * Minimal mdast node shape we touch. Kept local so this plugin does not pull
 * in @types/mdast just to rewrite text nodes.
 */
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

/** Split a text node value into text + link nodes around `[[...]]` spans. */
function splitText(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(value)) !== null) {
    if (match.index > last) {
      out.push({ type: "text", value: value.slice(last, match.index) });
    }
    const resolved = resolveWikilink(match[1]);
    if (!resolved) {
      out.push({ type: "text", value: match[0] });
    } else {
      out.push({
        type: "link",
        // Path-style targets get a real Explorer href; title-only targets use
        // a `wiki:` sentinel so the renderer shows a non-navigating chip.
        url: resolved.href ?? `wiki:${resolved.label}`,
        children: [{ type: "text", value: resolved.label }],
      });
    }
    last = match.index + match[0].length;
  }
  if (last < value.length) {
    out.push({ type: "text", value: value.slice(last) });
  }
  return out;
}

function transformChildren(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const node of nodes) {
    if (
      node.type === "text" &&
      typeof node.value === "string" &&
      node.value.includes("[[")
    ) {
      out.push(...splitText(node.value));
      continue;
    }
    // Don't rewrite inside existing links (avoid nested links). Code nodes
    // carry `value`, not `children`, so they are naturally skipped.
    if (
      node.type !== "link" &&
      node.type !== "linkReference" &&
      Array.isArray(node.children)
    ) {
      node.children = transformChildren(node.children);
    }
    out.push(node);
  }
  return out;
}

/** remark plugin: rewrite `[[wikilinks]]` into mdast link nodes. */
export default function remarkWikilinks() {
  return (tree: MdNode) => {
    if (Array.isArray(tree.children)) {
      tree.children = transformChildren(tree.children);
    }
  };
}
