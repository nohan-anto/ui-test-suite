import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { CopilotAdapter } from "./copilot.ts";
import { MockAdapter } from "./mock.ts";
import type { AgentAdapter } from "./types.ts";

/** To support a new provider: implement AgentAdapter (usually by extending CliAdapter) and register it here. */
const factories: Record<string, (bin?: string | null) => AgentAdapter> = {
  claude: (bin) => new ClaudeAdapter(bin ?? undefined),
  codex: (bin) => new CodexAdapter(bin ?? undefined),
  copilot: (bin) => new CopilotAdapter(bin ?? undefined),
  mock: () => new MockAdapter(),
};

export const AGENT_IDS = Object.keys(factories);

export function createAgent(provider: string, bin?: string | null): AgentAdapter {
  const f = factories[provider];
  if (!f) throw new Error(`Unknown agent provider "${provider}". Known: ${AGENT_IDS.join(", ")}`);
  return f(bin);
}
