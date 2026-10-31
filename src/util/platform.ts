/** Windows/POSIX differences in one place. */
export const isWindows = process.platform === "win32";

/** MCP stdio servers launched through npx. On Windows npx is a .cmd shim, which agent CLIs can only start via cmd /c. */
export function npxServer(args: string[]): { command: string; args: string[] } {
  return isWindows ? { command: "cmd", args: ["/c", "npx", ...args] } : { command: "npx", args };
}

/**
 * Resolve a command for Bun.spawn. npm-installed CLIs (copilot, codex, claude) are .cmd shims on Windows,
 * which CreateProcess cannot run directly, so they go through cmd.exe.
 */
export function resolveCommand(cmd: string[]): string[] {
  const [bin, ...rest] = cmd;
  if (!isWindows || !bin) return cmd;
  const resolved = Bun.which(bin) ?? bin;
  return /\.(cmd|bat)$/i.test(resolved) ? ["cmd.exe", "/d", "/s", "/c", resolved, ...rest] : [resolved, ...rest];
}

