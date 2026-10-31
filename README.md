# uitest

Plan and run UI tests for a Jira ticket using any AI coding agent (GitHub Copilot CLI, Claude Code or Codex) and your **already signed-in Chrome** session.

```
uitest plan CIS-601     # phase 1: Jira + MRs + local code → questions to you → test-cases.md
uitest test CIS-601     # phase 2: run each case in your signed-in Chrome tab → test-report.md
```

## How it works

```
uitest (Bun CLI, does all deterministic work)
 ├─ Jira Cloud (GET only)  story, ACs, comments, links; epics → every child story
 ├─ GitLab (GET only)      MRs from story text, remote links, and title/branch search → diffs, commits, discussion
 ├─ Local repos (read only) lexical index (routes, components, API endpoints, flags, i18n) + git commit checks
 │                          → impact map: changed file → importers → UI routes; downstream API → UI callers
 ├─ Context bundle         runs/<TICKET>/<run>/context/*.md   (exactly what the agent sees)
 └─ Agent adapter          copilot | claude | codex | mock
        └─ MCP: chrome-devtools-mcp (attached to your Chrome) [+ Atlassian Rovo] [+ extras]
```

**Phase 1 (plan).** The agent reads the context bundle and the repos, and can look at the live UI. It is instructed to **ask instead of assuming**. Its questions are asked in your terminal, and your answers go back to it for the next round. This repeats until it has no questions left and you accept the draft. Output: `test-cases.md`, which you can edit. `questions.md` records every Q&A.

**Phase 2 (test).** A preflight finds your signed-in app tab and stops if it is on OneLogin. Each test case runs in a separate agent call. Cases tagged `destructive` ask you for confirmation first. If a step is ambiguous, the run is marked `blocked` and the agent's question goes to you. Output: `test-report.md` with a pass/fail summary, failed steps (expected vs actual), console and network errors, screenshots and an AC → test case traceability table.

```
runs/CIS-601/<plan-run>/
  context/            story.md, children/*.md, mrs.md, impact.md, repos/*.md, manifest.json
  questions.md        every question the agent asked + your answers
  test-cases.md       the plan (edit before testing if you like)
  test-report.md      latest test run's report
  transcripts/        raw prompts/replies per planning round
  test-runs/<ts>/     results.json, test-report.md, evidence/*.png, transcripts/
```

## Setup

1. **Install Bun:** `curl -fsSL https://bun.sh/install | bash`, then `bun install`. Optional: `bun link` gives you a global `uitest` command. Otherwise use `bun src/cli.ts …`.
2. **Install your agent CLI** and sign in to it:
   - Copilot: `npm i -g @github/copilot`, then `copilot` (sign in)
   - Claude Code: `claude`
   - Codex: `npm i -g @openai/codex`, then `codex login`
3. **Create the config:** run `uitest init`, then edit `uitest.config.yaml` and `.env`.
   - Jira: email + [API token](https://id.atlassian.com/manage-profile/security/api-tokens)
   - GitLab: a personal access token with `read_api` and `read_repository` scopes
   - `repos`: local clones of your UI repo and downstream repos, each with its `gitlabProject` path
4. **Connect Chrome.** Use one of these:
   - **Dedicated debug profile (any Chrome version).** Chrome 136+ ignores `--remote-debugging-port` on your default profile, so start a separate one:
     ```
     google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.uitest-chrome"
     ```
     Sign in through OneLogin once in that window and keep the app tab open. The session persists in that profile.
   - **Auto-connect (Chrome 144+).** Enable remote debugging at `chrome://inspect/#remote-debugging` in your normal Chrome and set `browser.autoConnect: true`.
5. Run `uitest doctor`. It checks the agent CLI, the Chrome tab, Jira, GitLab and the repo paths.

## Commands

| Command | What it does |
| --- | --- |
| `uitest init` | Create `uitest.config.yaml` and `.env` from the examples |
| `uitest doctor [--agent id]` | Check every integration |
| `uitest index [repo] [--force]` | Build or refresh the repo indexes (cached per HEAD sha) |
| `uitest plan <TICKET> [--agent id] [--answers f.json] [--fixtures dir]` | Phase 1 |
| `uitest test <TICKET> [--run id] [--only TC-001,TC-003] [--agent id] [--skip-preflight]` | Phase 2. Exit code is 2 if any case fails or is blocked |
| `uitest report <TICKET> [--run id]` | Regenerate the report from saved results |

You can try everything offline with the mock agent and the recorded fixtures:
```
bun src/cli.ts plan DEMO-1 --agent mock --fixtures tests/fixtures
bun src/cli.ts test DEMO-1 --agent mock --skip-preflight
```

## Switching or adding agents

Set `agent.provider` in the config, or pass `--agent` for a single run. To add a provider:

1. Create `src/agents/<name>.ts` that extends `CliAdapter` and implements `buildInvocation()`. That method turns the neutral request (prompt, system prompt, MCP servers, readable dirs, model) into the CLI's flags. See `claude.ts`, `codex.ts` and `copilot.ts`.
2. Register it in `src/agents/registry.ts`.

Every agent must end its reply with a JSON block matching `src/phases/protocol.ts`. Invalid replies are retried once with the validation error. Agent CLI flags change between versions, so `uitest doctor` warns when a flag an adapter relies on is missing from `--help`.

> Adapter status: **claude** has been verified against Claude Code 2.1.x. **copilot** and **codex** were built from their documented headless flags. Run `uitest doctor --agent copilot` on your work machine and adjust the adapter if it reports missing flags.

## Safety

- The Jira and GitLab clients can only send GET requests. Tokens are redacted from the context bundle.
- Repos are never modified. `git fetch` only runs if `indexing.fetchBeforeIndex: true`.
- Agents get read and MCP tools only. File writes and the shell are denied.
- The agent never types credentials. If the tab shows OneLogin, the run stops and asks you to sign in.
- Planning must not submit forms (set `browser.planObserveOnly: true` to remove input tools entirely). The agent is told to stay within `allowedOrigins`. To have the browser block every other origin, set `browser.enforceAllowedOrigins: true` (Chrome 149+).

## Development

```
bun test             # unit tests and an offline end-to-end run (mock agent + fixtures)
bunx tsc --noEmit    # typecheck
```
