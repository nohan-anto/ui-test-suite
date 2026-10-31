/** Minimal Atlassian Document Format → Markdown converter covering the node types Jira stories use. */

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
}

export function adfToMarkdown(doc: unknown): string {
  if (doc == null) return "";
  if (typeof doc === "string") return doc; // already plain text (API v2 or rendered)
  return block(doc as AdfNode, 0).replace(/\n{3,}/g, "\n\n").trim();
}

function inline(nodes: AdfNode[] = []): string {
  return nodes.map(inlineNode).join("");
}

function inlineNode(n: AdfNode): string {
  switch (n.type) {
    case "text":
      return applyMarks(n.text ?? "", n.marks);
    case "hardBreak":
      return "  \n";
    case "mention":
      return `@${n.attrs?.text?.replace(/^@/, "") ?? n.attrs?.id ?? "user"}`;
    case "emoji":
      return n.attrs?.text ?? n.attrs?.shortName ?? "";
    case "inlineCard":
    case "blockCard":
      return n.attrs?.url ? `<${n.attrs.url}>` : "";
    case "date":
      return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "status":
      return `[${n.attrs?.text ?? ""}]`;
    default:
      return n.content ? inline(n.content) : (n.text ?? "");
  }
}

function applyMarks(text: string, marks: AdfNode["marks"] = []): string {
  let t = text;
  for (const m of marks) {
    if (m.type === "code") t = `\`${t}\``;
    else if (m.type === "strong") t = `**${t}**`;
    else if (m.type === "em") t = `_${t}_`;
    else if (m.type === "strike") t = `~~${t}~~`;
    else if (m.type === "link") t = `[${t}](${m.attrs?.href ?? ""})`;
  }
  return t;
}

function block(n: AdfNode, depth: number): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case "doc":
      return kids.map((k) => block(k, depth)).join("\n\n");
    case "paragraph":
      return inline(kids);
    case "heading":
      return `${"#".repeat(Math.min(6, (n.attrs?.level ?? 1) + 1))} ${inline(kids)}`;
    case "bulletList":
    case "orderedList":
      return kids
        .map((li, i) => listItem(li, depth, n.type === "orderedList" ? `${i + 1}.` : "-"))
        .join("\n");
    case "taskList":
      return kids
        .map((t) => `${"  ".repeat(depth)}- [${t.attrs?.state === "DONE" ? "x" : " "}] ${inline(t.content)}`)
        .join("\n");
    case "codeBlock":
      return `\`\`\`${n.attrs?.language ?? ""}\n${kids.map((k) => k.text ?? "").join("")}\n\`\`\``;
    case "blockquote":
      return kids
        .map((k) => block(k, depth))
        .join("\n\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "panel":
      return `> **${(n.attrs?.panelType ?? "note").toUpperCase()}:** ${kids.map((k) => block(k, depth)).join("\n> ")}`;
    case "rule":
      return "---";
    case "table":
      return table(n);
    case "mediaSingle":
    case "mediaGroup":
      return kids.map((m) => `[attachment: ${m.attrs?.alt ?? m.attrs?.id ?? "media"}]`).join(" ");
    case "expand":
    case "nestedExpand":
      return `**${n.attrs?.title ?? "Details"}**\n\n${kids.map((k) => block(k, depth)).join("\n\n")}`;
    default:
      return kids.length ? kids.map((k) => block(k, depth)).join("\n\n") : inlineNode(n);
  }
}

function listItem(li: AdfNode, depth: number, bullet: string): string {
  const indent = "  ".repeat(depth);
  const parts = (li.content ?? []).map((c) =>
    c.type === "bulletList" || c.type === "orderedList" ? block(c, depth + 1) : `${indent}${bullet} ${block(c, depth)}`,
  );
  return parts.join("\n");
}

function table(n: AdfNode): string {
  const rows = (n.content ?? []).map((r) =>
    (r.content ?? []).map((cell) =>
      (cell.content ?? []).map((c) => block(c, 0)).join(" ").replace(/\|/g, "\\|").replace(/\n/g, " "),
    ),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const [head, ...body] = rows.map(pad);
  return [
    `| ${head!.join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}
