import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveCommand } from "./platform.ts";

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("***");
  return out;
}

export async function writeText(path: string, content: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, content);
}

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a command without a shell. Never throws on non-zero exit. */
export async function exec(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number; stdin?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(resolveCommand(cmd), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { code: 127, stdout: "", stderr: String(e), timedOut: false };
  }
  if (opts.stdin) proc.stdin.write(opts.stdin);
  proc.stdin.end();

  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : undefined;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
