import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { ConfigSchema, type Config } from "./schema.ts";

export const DEFAULT_CONFIG_FILE = "uitest.config.yaml";

/** Replace ${VAR} references with environment values. Missing vars become "". */
export function interpolateEnv(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env)]));
  }
  return value;
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

export function parseConfig(text: string, env: Record<string, string | undefined> = process.env): Config {
  const raw = YAML.parse(text) ?? {};
  const cfg = ConfigSchema.parse(interpolateEnv(raw, env));
  cfg.repos = cfg.repos.map((r) => ({ ...r, path: expandHome(r.path) }));
  cfg.browser.profileDir = expandHome(cfg.browser.profileDir);
  return cfg;
}

export async function loadConfig(path = DEFAULT_CONFIG_FILE): Promise<Config> {
  if (!existsSync(path)) {
    throw new Error(`Config not found: ${path}. Run "uitest init" to create one.`);
  }
  return parseConfig(await Bun.file(path).text());
}

/** Values that must never appear in logs or context bundles. */
export function secretsOf(cfg: Config): string[] {
  return [cfg.jira.token, cfg.gitlab.token ?? ""].filter((s) => s && s.length >= 6);
}
