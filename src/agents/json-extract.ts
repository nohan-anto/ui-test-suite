import type { z } from "zod";

/** Pull the last JSON object out of an agent reply: a ```json fence first, else the last balanced {...}. */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  for (const candidate of fences.reverse()) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  const end = text.lastIndexOf("}");
  for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  throw new Error("No JSON object found in agent reply");
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseAgentJson<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  let data: unknown;
  try {
    data = extractJson(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  };
}
