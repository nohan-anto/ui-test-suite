# Instructions for agents developing uitest

> If you were started **by uitest** to plan or run UI tests (your working directory is under `runs/`), ignore this file. Follow only the system prompt you were given.

Read [`docs/PROJECT.md`](docs/PROJECT.md) before making changes. It is the shared guide for all agents (Claude, Codex, Copilot): architecture, file index, commands, invariants, and current status.

Essentials:
- Bun + TypeScript. Check with `bun test` and `bun run typecheck`. Both must pass.
- The target machine is **Windows** (PowerShell). Keep everything cross-platform (`node:path`, `resolveCommand`, `npxServer`).
- Jira, GitLab and git access is **read-only**. Never automate credentials or SSO in the browser.
- Provider-specific code goes only in `src/agents/<id>.ts`. Phases use the `AgentAdapter` interface.
- **Do not commit or push.** The user commits themselves.
- **Every change updates `docs/PROJECT.md` in the same change:** add an entry under *Unreleased* in the version history, bump *Doc revision*, set *Last updated*, and update the file index or commands if they changed. See section 10 of `docs/PROJECT.md`. Also update `uitest.config.example.yaml` and `README.md` where relevant.
