/** Provider-neutral MCP server specs. Adapters translate these into each agent CLI's own config format. */
import type { Config, McpServerSpec } from "../config/schema.ts";

export const CHROME_MCP_NAME = "chrome-devtools";

export interface BrowserMcpOptions {
  /** Directory the MCP may write screenshots into. */
  workspace?: string;
  /** Plan phase: strip input tools so the agent can only navigate and observe. */
  observeOnly?: boolean;
}

export function chromeDevtoolsServer(cfg: Config, opts: BrowserMcpOptions = {}): McpServerSpec {
  const b = cfg.browser;
  if (b.mcp !== "chrome-devtools") return b.mcp;
  const args = ["-y", "chrome-devtools-mcp@latest"];
  args.push(b.autoConnect ? "--autoConnect" : `--browserUrl=${b.browserUrl}`);
  args.push("--usageStatistics=false", "--performanceCrux=false");
  if (opts.workspace) args.push(`--workspace=${opts.workspace}`);
  if (opts.observeOnly) args.push("--categoryInput=false");
  if (b.enforceAllowedOrigins) {
    const origins = b.allowedOrigins.length ? b.allowedOrigins : [new URL(b.appBaseUrl).origin];
    for (const o of origins) args.push(`--allowedUrlPattern=${o.replace(/\/+$/, "")}/*`);
  }
  return { name: CHROME_MCP_NAME, command: "npx", args, env: {}, headers: {} };
}

export function rovoServer(cfg: Config): McpServerSpec | null {
  if (!cfg.jira.rovo.enabled) return null;
  // Atlassian Remote MCP (Rovo). Auth is OAuth, completed by the agent CLI on first use.
  return { name: "atlassian", command: "npx", args: ["-y", "mcp-remote", cfg.jira.rovo.url], env: {}, headers: {} };
}

export function mcpServersFor(cfg: Config, opts: BrowserMcpOptions = {}): McpServerSpec[] {
  return [chromeDevtoolsServer(cfg, opts), rovoServer(cfg), ...cfg.extraMcpServers].filter(
    (s): s is McpServerSpec => s !== null,
  );
}

/** The `{ mcpServers: {...} }` JSON shape used by Claude Code and Copilot CLI. */
export function toMcpJson(servers: McpServerSpec[], flavor: "claude" | "copilot") {
  const mcpServers: Record<string, any> = {};
  for (const s of servers) {
    if (s.url) {
      mcpServers[s.name] = { type: "http", url: s.url, headers: s.headers, ...(flavor === "copilot" ? { tools: ["*"] } : {}) };
    } else {
      mcpServers[s.name] = {
        ...(flavor === "copilot" ? { type: "local", tools: ["*"] } : { type: "stdio" }),
        command: s.command,
        args: s.args,
        env: s.env,
      };
    }
  }
  return { mcpServers };
}

/** Codex takes TOML config; we pass servers as `-c mcp_servers.<name>.<key>=<toml value>` overrides. */
export function toCodexOverrides(servers: McpServerSpec[]): string[] {
  const out: string[] = [];
  const toml = (v: unknown) => JSON.stringify(v); // JSON strings/arrays are valid TOML values
  for (const s of servers) {
    const k = `mcp_servers.${s.name.replace(/[^\w-]/g, "_")}`;
    if (s.url) {
      out.push("-c", `${k}.url=${toml(s.url)}`);
    } else {
      out.push("-c", `${k}.command=${toml(s.command)}`, "-c", `${k}.args=${toml(s.args)}`);
      for (const [ek, ev] of Object.entries(s.env)) out.push("-c", `${k}.env.${ek}=${toml(ev)}`);
    }
  }
  return out;
}
