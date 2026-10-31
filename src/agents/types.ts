import type { McpServerSpec } from "../config/schema.ts";

export type AgentMode = "plan" | "test";

export interface AgentRequest {
  prompt: string;
  systemPrompt: string;
  mcpServers: McpServerSpec[];
  /** Directories the agent may read (context bundle, local repos). First entry is the working directory. */
  workDirs: string[];
  mode: AgentMode;
  timeoutMs: number;
  model?: string | null;
  extraArgs?: string[];
}

export interface AgentResponse {
  text: string;
  raw: unknown;
}

export interface DoctorResult {
  ok: boolean;
  version?: string;
  messages: string[];
}

export interface AgentAdapter {
  readonly id: string;
  doctor(): Promise<DoctorResult>;
  run(req: AgentRequest): Promise<AgentResponse>;
}

/** What the adapter will execute; split out so command construction is unit-testable. */
export interface Invocation {
  cmd: string[];
  stdin?: string;
  /** Temp files the adapter must write before running: path → content. */
  files: Record<string, string>;
  /** Codex writes the final message to a file instead of stdout. */
  outputFile?: string;
}
