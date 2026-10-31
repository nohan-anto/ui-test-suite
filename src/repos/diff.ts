/** Unified-diff helpers: which lines of which files changed. */

export type Range = [number, number];

export interface FileChange {
  /** Changed line ranges in the new file; "all" when unknown (no or truncated diff). */
  ranges: Range[] | "all";
  added: string[];
  removed: string[];
}

export type RepoChanges = Map<string, FileChange>;

/** Hunk ranges (new-file side) and +/- lines of a single-file diff body (GitLab `diff` field). */
export function parseFileDiff(diff: string): FileChange {
  const ranges: Range[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      const start = Number(h[1]);
      const len = h[2] === undefined ? 1 : Number(h[2]);
      ranges.push([start, start + Math.max(len, 1) - 1]);
    } else if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
  }
  return { ranges: ranges.length && !diff.includes("… [truncated") ? ranges : "all", added, removed };
}

/** Split `git show` / `git diff` output into per-file changes, keyed by new path. */
export function parseMultiFileDiff(text: string): RepoChanges {
  const out: RepoChanges = new Map();
  for (const part of text.split(/^diff --git /m).slice(1)) {
    const path = part.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? part.match(/^a\/\S+ b\/(\S+)/)?.[1];
    if (!path || path === "/dev/null") continue;
    out.set(path, parseFileDiff(part));
  }
  return out;
}

export function mergeChange(into: RepoChanges, file: string, c: FileChange): void {
  const prev = into.get(file);
  if (!prev) return void into.set(file, c);
  into.set(file, {
    ranges: prev.ranges === "all" || c.ranges === "all" ? "all" : [...prev.ranges, ...c.ranges],
    added: [...prev.added, ...c.added],
    removed: [...prev.removed, ...c.removed],
  });
}

/**
 * Items (sorted by line within one file) whose span [line, nextItem.line - 1] overlaps a changed range.
 * Approximates "which resolver/field/operation body did this hunk touch".
 * `singleLine` for declarations that occupy one line (SDL fields), so a later hunk isn't blamed on the last field.
 */
export function touchedItems<T extends { line: number }>(items: T[], ranges: Range[] | "all", singleLine = false): T[] {
  if (ranges === "all") return items;
  const sorted = [...items].sort((a, b) => a.line - b.line);
  return sorted.filter((it, i) => {
    const end = singleLine ? it.line : (sorted[i + 1]?.line ?? Infinity) - 1;
    return ranges.some(([s, e]) => s <= end && e >= it.line);
  });
}

/** Field names added/removed in SDL lines, e.g. "+  status: OrderStatus!" → "status". */
export function sdlFieldNamesInLines(lines: string[]): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    const m = l.match(/^\s*([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*[\[\w]/);
    if (m && !/^(type|input|interface|enum|union|scalar|schema|extend|query|mutation|subscription)$/.test(m[1]!)) out.add(m[1]!);
  }
  return [...out];
}
