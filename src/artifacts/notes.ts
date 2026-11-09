/**
 * notes.md: things the user told the agent to consider (test data, accounts, routes, focus, exclusions).
 * Written by `uitest chat` and the pre-test prompt, read by every test case. Hand-editable: one "- " bullet per note.
 */
export function parseNotes(md: string): string[] {
  return md
    .split("\n")
    .map((l) => l.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim())
    .filter((l): l is string => !!l);
}

export function renderNotes(ticket: string, notes: string[]): string {
  return [
    `# Things to consider: ${ticket}`,
    "",
    "> From `uitest chat` and the start of `uitest test`. Every test case gets these. Edit or delete lines freely.",
    "",
    ...notes.map((n) => `- ${n}`),
    "",
  ].join("\n");
}

/** Append notes, skipping exact (case-insensitive) duplicates. */
export function mergeNotes(existing: string[], added: string[]): string[] {
  const seen = new Set(existing.map((n) => n.toLowerCase()));
  const out = [...existing];
  for (const n of added.map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  }
  return out;
}

export async function readNotes(path: string): Promise<string[]> {
  const f = Bun.file(path);
  return (await f.exists()) ? parseNotes(await f.text()) : [];
}
