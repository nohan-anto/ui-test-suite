/**
 * Token / credit usage reported by agent CLIs, normalised. Every field is optional: each CLI reports a different
 * subset (Claude: tokens + USD cost; Codex: tokens; Copilot: estimated premium requests, sometimes tokens).
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider-reported cost in USD (Claude Code). */
  costUsd?: number;
  /** GitHub Copilot premium requests (Copilot's own estimate). */
  premiumRequests?: number;
  models?: string[];
}

const KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "premiumRequests"] as const;

export function addUsage(a: AgentUsage | undefined, b: AgentUsage | undefined): AgentUsage | undefined {
  if (!a) return b && { ...b };
  if (!b) return { ...a };
  const out: AgentUsage = {};
  for (const k of KEYS) if (a[k] !== undefined || b[k] !== undefined) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  const models = [...new Set([...(a.models ?? []), ...(b.models ?? [])])];
  if (models.length) out.models = models;
  return out;
}

export const hasUsage = (u?: AgentUsage) => !!u && KEYS.some((k) => u[k] !== undefined);

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** "12.3k in · 1.2k out · 40.0k cached · $0.0123 · 1 premium request" */
export function formatUsage(u?: AgentUsage): string {
  if (!hasUsage(u)) return "not reported";
  const parts: string[] = [];
  if (u!.inputTokens !== undefined) parts.push(`${compact(u!.inputTokens)} in`);
  if (u!.outputTokens !== undefined) parts.push(`${compact(u!.outputTokens)} out`);
  if (u!.cacheReadTokens) parts.push(`${compact(u!.cacheReadTokens)} cached`);
  if (u!.costUsd !== undefined) parts.push(`$${u!.costUsd.toFixed(4)}`);
  if (u!.premiumRequests !== undefined) parts.push(`${+u!.premiumRequests.toFixed(2)} premium request${u!.premiumRequests === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** "12.3k" / "1,234" / "1.2M" → number */
function num(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/,/g, "").match(/^([\d.]+)\s*([kKmM]?)$/);
  if (!m) return undefined;
  return Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1);
}

/** Claude Code `-p --output-format json` result object. */
export function claudeUsage(j: any): AgentUsage | undefined {
  if (!j || typeof j !== "object") return undefined;
  const u = j.usage ?? {};
  const out: AgentUsage = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens,
    costUsd: j.total_cost_usd ?? j.cost_usd,
    models: j.modelUsage ? Object.keys(j.modelUsage) : undefined,
  };
  for (const k of Object.keys(out) as (keyof AgentUsage)[]) if (out[k] === undefined) delete out[k];
  return hasUsage(out) ? out : undefined;
}

/**
 * Codex `exec --json` JSONL: the last `turn.completed` event's usage (a running total for the thread, and this
 * adapter starts a fresh thread per call). Falls back to the plain-text "tokens used" line older builds print.
 */
export function codexUsage(stdout: string, stderr = ""): AgentUsage | undefined {
  let last: any;
  for (const line of stdout.split("\n")) {
    if (!line.includes("usage")) continue;
    try {
      const e = JSON.parse(line);
      const u = e.usage ?? e.msg?.info?.total_token_usage;
      if (u) last = u;
    } catch {}
  }
  if (last) {
    return {
      inputTokens: last.input_tokens,
      outputTokens: last.output_tokens,
      cacheReadTokens: last.cached_input_tokens,
      cacheWriteTokens: last.cache_write_input_tokens,
    };
  }
  const total = num((stdout + "\n" + stderr).match(/tokens used[:\s]*([\d,.]+[kKmM]?)/i)?.[1]);
  return total === undefined ? undefined : { inputTokens: total };
}

/**
 * Copilot CLI's end-of-session summary (estimates), e.g.
 *   Total usage est:       1 Premium request
 *   Usage by model:
 *       claude-sonnet-4.5    13.3k input, 120 output, 0 cache read, 0 cache write (Est. 1 Premium request)
 */
export function copilotUsage(stdout: string, stderr = ""): AgentUsage | undefined {
  const text = `${stdout}\n${stderr}`;
  const out: AgentUsage = {};
  const premium = text.match(/Total usage est[^:\n]*:\s*([\d.]+)\s*Premium requests?/i);
  if (premium) out.premiumRequests = Number(premium[1]);
  const models: string[] = [];
  for (const m of text.matchAll(/^\s*([\w.\-/:]+)\s+([\d.,]+[kKmM]?)\s+input,\s*([\d.,]+[kKmM]?)\s+output(?:,\s*([\d.,]+[kKmM]?)\s+cache read)?(?:,\s*([\d.,]+[kKmM]?)\s+cache write)?/gim)) {
    models.push(m[1]!);
    out.inputTokens = (out.inputTokens ?? 0) + (num(m[2]) ?? 0);
    out.outputTokens = (out.outputTokens ?? 0) + (num(m[3]) ?? 0);
    if (m[4]) out.cacheReadTokens = (out.cacheReadTokens ?? 0) + (num(m[4]) ?? 0);
    if (m[5]) out.cacheWriteTokens = (out.cacheWriteTokens ?? 0) + (num(m[5]) ?? 0);
  }
  if (models.length) out.models = models;
  return hasUsage(out) ? out : undefined;
}

/** Collects usage per labelled agent call (plan round, test case) for one command. */
export class UsageMeter {
  readonly entries: { label: string; usage?: AgentUsage }[] = [];
  add(label: string, usage?: AgentUsage) {
    this.entries.push({ label, usage });
  }
  total(label?: string): AgentUsage | undefined {
    return this.entries.filter((e) => label === undefined || e.label === label).reduce<AgentUsage | undefined>((t, e) => addUsage(t, e.usage), undefined);
  }
  calls() {
    return this.entries.length;
  }
}

/** UITEST_SHOW_USAGE=true|false|1|0|yes|no|on|off; anything else (or unset) → undefined. */
export function envFlag(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off", ""].includes(s)) return false;
  return undefined;
}
