# uitest

Plan and run UI tests for a Jira ticket using any AI coding agent (GitHub Copilot CLI, Claude Code or Codex) and your **already signed-in Chrome** session.

```
uitest plan CIS-601     # phase 1: Jira + MRs + local code → questions to you → test-cases.md
uitest test CIS-601     # phase 2: run each case in your signed-in Chrome tab → test-report.md
```

## Quick start: commands in order

**Once per machine**
```
bun install                # dependencies
bun link                   # makes the `uitest` command available (open a new terminal afterwards)
uitest init                # creates uitest.config.yaml and .env; fill them in (see Setup below)
                           # optional: UITEST_SHOW_USAGE=true in .env to see tokens / AI credits used
```

**Once per working session**
```
uitest chrome              # starts Chrome with remote debugging; sign in via OneLogin in that window (first time only)
uitest doctor              # everything should be green: agent, Chrome tab, Jira, GitLab, repos
uitest index               # refresh repo indexes (fast when nothing changed; add --force to rebuild)
```

**For each ticket**
```
uitest plan CIS-601        # answer the agent's questions, accept the draft → test-cases.md
uitest chat CIS-601        # optional: ask what/how it will test (routes, screens), give test data → notes.md
uitest test CIS-601        # asks once for anything else to consider, then runs every case → test-report.md
```

**After failures**
```
uitest test CIS-601 --failed          # re-run only failed/blocked cases
uitest test CIS-601 --only TC-003     # re-run specific cases
uitest report CIS-601                 # rebuild test-report.md from saved results
```

**Share the result on the story** (optional, needs `jira.publish.enabled: true`)
```
uitest publish CIS-601 --dry-run      # preview the comment and the list of screenshots
uitest publish CIS-601                # post it as a comment, with screenshots attached
```

The report is at `runs/CIS-601/<run>/test-report.md`. Without `bun link`, use `bun src/cli.ts <command>` instead of `uitest <command>`.

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

**GraphQL- and REST-aware impact.** Repos get one of three roles: `ui`, `gateway` (the middle service the UI calls, GraphQL or a REST BFF) or `downstream` (the services behind it, GraphQL subgraphs or REST APIs, in any mix). For every changed resolver or schema field (line-accurate, from MR diffs and local commits), `impact.md` traces the full chain:

```
subgraph field Query.ordersByCustomer (Go resolver changed)
  → gateway resolver Query.customerOrders (sends query OBC)
    → UI query GetOrders (src/graphql/orders.ts) → screens /orders
```

It also works in the other direction, from a UI or gateway change to the subgraphs behind it, and it flags changed type fields (e.g. a new `Order.status`) that UI operations select. Recognised patterns:

- **UI:** gql`` tags
- **Gateway:** schema-first SDL (`.graphql` files or `typeDefs`) with resolver maps, plus the gql operations it sends to subgraphs
- **Subgraphs:** Node schema-first, Go gqlgen (`.graphqls` + `func (r *queryResolver) X`), .NET Hot Chocolate (`[QueryType]` / `[ExtendObjectType("Query")]` / `class Query`, with `GetXAsync` read as `x`)

Links are made by field name, so treat them as strong hints, not proof.

**REST downstreams** are traced the same way, in a "REST impact chains" section. A changed endpoint, or a service or repository method behind it (followed to the controller up to two calls away), is linked to the gateway code that calls it, the resolver or BFF route that owns that code, and the UI operations or HTTP calls and screens on top:

```
GET api/Orders/{id} (orders-dotnet: Controllers/OrdersController.cs, reached via LoadOrderAsync())
  → gateway resolver Query.order (calls GET orders/${id})
    → UI query GetOrder → screens /orders/:id
```

A changed HTTP call in the UI or gateway is listed with the endpoints it hits. Calls and routes are matched by trailing path segments and method, so base URLs and `/api` prefixes don't need to line up. Recognised:

- **Routes:**
  - Node: Express/Fastify/router objects, NestJS
  - ASP.NET: `[Route]` + `[HttpGet]` controllers, minimal APIs with `MapGroup`
  - Go: net/http including `"GET /x"` patterns, gin/echo/fiber groups, chi, gorilla `.Methods()`
  - Spring, Flask/FastAPI
- **Calls:**
  - `fetch`, axios-style clients, Apollo `RESTDataSource`
  - `HttpClient` (`GetAsync`…), RestSharp
  - Go `http.Get`/`NewRequest`, `fmt.Sprintf` URLs, resty
  - RestTemplate/WebClient, requests/httpx

`uitest index` prints the GraphQL and REST counts per repo, so you can check that your repos are being read.

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
   - **Dedicated debug profile (any Chrome version).** Chrome 136+ ignores `--remote-debugging-port` on your default profile, so uitest uses a separate profile. Start it with:
     ```
     uitest chrome
     ```
     This finds Chrome for your OS, starts it on the port in `browser.browserUrl` with the profile in `browser.profileDir` (default `~/.uitest-chrome`), and opens `appBaseUrl`. Sign in through OneLogin once in that window and keep the app tab open. The session persists in that profile. `uitest test` also offers to start Chrome when it isn't running. To start it by hand instead (`uitest chrome --print` prints the exact command):

     | OS | Command |
     | --- | --- |
     | Windows (PowerShell) | `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.uitest-chrome"` |
     | Windows (cmd) | `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.uitest-chrome"` |
     | macOS | `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.uitest-chrome"` |
     | Linux | `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.uitest-chrome"` |

     In PowerShell the `&` is required: without it, a quoted path is a string and the arguments cause *Unexpected token*. If Chrome is installed per user on Windows, it is in `$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe` (`uitest chrome` checks there too). Check it worked by opening `http://127.0.0.1:9222/json/version`.
   - **Auto-connect (Chrome 144+).** Enable remote debugging at `chrome://inspect/#remote-debugging` in your normal Chrome and set `browser.autoConnect: true`.
5. Run `uitest doctor`.

### Windows notes

- **Bun version:** `bun.lock` needs Bun ≥ 1.2. If `bun install` says *unknown lockfile version*, run `bun upgrade` (or reinstall: `powershell -c "irm bun.sh/install.ps1 | iex"`). If you can't upgrade, delete `bun.lock` and run `bun install` to regenerate it.
- **Chrome debug profile:** run `uitest chrome`. To do it by hand, see the table in Setup step 4. PowerShell needs `&` before the quoted chrome.exe path. If Chrome isn't in a standard location, set `browser.chromePath`.
- **Repo paths in YAML:** use forward slashes or single quotes. In double quotes, backslashes are escape characters:
  ```yaml
  path: C:/work/web-ui          # ok
  path: 'C:\work\web-ui'          # ok
  path: "C:\work\web-ui"          # wrong: \w is read as an escape
  ```
- npm-installed agent CLIs (`copilot.cmd`, `codex.cmd`) are started through `cmd.exe` automatically, and MCP servers use `cmd /c npx …`. You don't need to configure either.
- `git` must be on PATH (Git for Windows). ripgrep is not required. It checks the agent CLI, the Chrome tab, Jira, GitLab and the repo paths.

## Commands

| Command | What it does |
| --- | --- |
| `uitest init` | Create `uitest.config.yaml` and `.env` from the examples |
| `uitest chrome [--print]` | Start Chrome with remote debugging on the uitest profile (Windows, macOS, Linux), or print the command |
| `uitest doctor [--agent id]` | Check every integration |
| `uitest index [repo] [--force]` | Build or refresh the repo indexes (cached per HEAD sha) |
| `uitest plan <TICKET> [--agent id] [--answers f.json] [--fixtures dir]` | Phase 1 |
| `uitest test <TICKET> [--run id] [--only TC-001,TC-003] [--failed] [--no-ask] [--agent id] [--skip-preflight]` | Phase 2. Exit code is 2 if any case fails or is blocked |
| `uitest chat <TICKET> [--run id] [--agent id]` | Chat with the agent about the plan; things to consider go to `notes.md`, plan changes to `test-cases.md` |
| `uitest report <TICKET> [--run id]` | Regenerate the report from saved results |
| `uitest publish <TICKET> [--run id] [--test-run id] [--to KEY] [--dry-run] [--yes]` | Post the report to the Jira story as a comment, with screenshots attached |

### Chatting about the plan, and giving test data

After planning, `uitest chat CIS-601` opens a conversation with the agent about its plan. It has the same read-only access as planning: the context bundle, your repos, and the signed-in tab to look at (no changes).

```
You: which route does TC-002 use?
agent: TC-002 starts on /orders/:id (src/pages/orders/[id].tsx, reached via the GetOrder chain in impact.md).
You: use order 10045 for the order cases, and log in as a Standard user
agent: Noted.
  Saved to notes.md (used by every test case):
    • Use order 10045 for the order cases
    • Run as a Standard user
You: also add a case for an order with no items
  Apply these changes to test-cases.md?
    + TC-006: Order with no items shows the empty state (new)
```

- **Ask anything about the plan:** what a case covers, which route or screen or API it uses, why a case exists, what's not covered.
- **Things to consider:** test data, accounts, roles, routes, focus areas, things to skip. They are saved to `runs/<TICKET>/<run>/notes.md`, and **every test case** gets them. You can edit that file by hand.
- **Changing the plan:** when you ask for a change, the agent proposes an updated case list, and you confirm before `test-cases.md` is rewritten.
- **When it runs:** whenever you like. Before testing, or after a run (e.g. give the right data, then `uitest test CIS-601 --failed`).
- **The conversation** is kept in `chat.md`.
- **At the start of `uitest test`** you're asked once: *"Anything else the agent should consider for this run?"* Type something to add it to `notes.md`, or press Enter to start. `--no-ask` skips the question.

### Re-running tests

```
uitest test CIS-601 --failed          # re-run only the cases that failed or were blocked last time
uitest test CIS-601 --only TC-003     # re-run specific cases
uitest test CIS-601                   # re-run everything
```

Each run gets its own folder under `test-runs/`, so earlier results and evidence are kept. After a partial run (`--failed` or `--only`), `test-report.md` still covers **every** case. Cases that weren't re-run keep their last result, marked `↩ <test run id>`, with evidence links to that run. The exit code reflects the overall result. To re-run after a fix, you can edit `test-cases.md` first (steps, expected results, test data). The next run uses your edits.

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

### Posting the report to Jira

`uitest publish CIS-601` takes the latest test run and adds a comment to the story containing:
- the verdict and counts
- the environment, agent and MRs
- a table of every case with its status
- failed steps (expected vs actual) with notes and console/network errors
- the screenshots, shown inline as thumbnails

The screenshots are uploaded as attachments on the issue. The full `test-report.md` is attached too, and the comment links to it.

- **Off by default.** This is the only thing uitest ever writes to Jira. Turn it on in config:
  ```yaml
  jira:
    publish:
      enabled: true
      token: ${JIRA_WRITE_TOKEN}   # optional; leave null to use jira.token
      attach: all                  # all | failures | none
      attachReport: true
  ```
  The token's account needs the **Add comments** and **Create attachments** permissions on the project. If your main token is read-only, create a second one and set `JIRA_WRITE_TOKEN` in `.env`. `uitest doctor` checks it.
- **Always previewed.** The comment is saved to `test-runs/<id>/jira-comment.txt` and shown with the attachment list. Nothing is posted until you confirm (`--yes` skips the question; `--dry-run` never posts).
- **Re-publishing is safe.** Attachments are named `uitest-<testRunId>-<file>`, and files already on the issue are not uploaded again. If a test run was already posted, you're asked before a second comment goes up (logged in `published.json`).
- **Epics:** the comment goes on the ticket you name. Use `--to CIS-602` to post on a child story instead.
- Very large reports are trimmed to fit Jira's comment limit. The summary table is always kept, and the attached report has everything.

### AI usage (tokens and credits)

Set `UITEST_SHOW_USAGE=true` in `.env` (or `agent.showUsage: true` in the config; the env value wins) to see what each agent call used:

```
◇ TC-001 → pass · AI usage: 14.8k in · 200 out · 2.0k cached · 1 premium request
◇ AI usage, this test run: 52.1k in · 1.4k out · 4 premium requests over 4 agent call(s)
```

- **Terminal:** `plan` shows usage per planning round and a total. `test` shows usage per case and a total.
- **Reports:** `test-report.md` gets an *AI usage* column and a run total. Carried-over cases show `—`, because their usage belongs to the earlier run.
- **Files:** `usage.json` (every call, including retries) is written to the plan run folder and each test-run folder.
- **Jira:** usage is never included in the comment that `uitest publish` posts.

What each agent reports:

| Agent | Reported | Notes |
| --- | --- | --- |
| Claude Code | tokens (in, out, cache) and **USD cost** | from `--output-format json`; reliable |
| Codex | tokens (in, out, cached) | from `codex exec --json` events |
| Copilot CLI | **premium requests** and tokens per model | parsed from Copilot's end-of-session summary. These are Copilot's own estimates, and it may not print the summary in `-p` mode on every version. If not, the usage shows *not reported*. Your account's real usage is on GitHub's billing page |

### Atlassian Rovo (optional)

Set `jira.rovo.enabled: true` to give the planning agent the Atlassian Rovo MCP server (Rovo search, Confluence, Jira). uitest does not need it: all Jira data is already collected through the REST API.

- **Endpoint:** `https://mcp.atlassian.com/v1/mcp/authv2` (Streamable HTTP). The old `/v1/sse` endpoint was retired on 30 June 2026. A config that still points to it is switched to the new URL automatically, and `uitest doctor` tells you to update it.
- **Sign-in:** with `transport: mcp-remote` (the default), a local `npx mcp-remote` bridge opens a browser for the Atlassian sign-in on first use and caches the token in `~/.mcp-auth`. This works the same for every agent. Sign in once interactively before a long run, so a headless run doesn't wait on it. With `transport: http`, the agent CLI connects to the URL itself and handles the sign-in.
- **Your Atlassian admin** must allow Rovo MCP for your site.
- **Caution:** the Rovo server includes tools that can edit Jira and Confluence, and uitest doesn't yet restrict the agent to its read-only tools. Keep it off unless you need it.

## Safety

- The Jira and GitLab clients can only send GET requests. Tokens are redacted from the context bundle. The one exception is `uitest publish`. It is off by default, lives in its own class (`src/sources/jira/publish.ts`), only adds a comment and attachments to the issue you name, and always asks first.
- Repos are never modified. `git fetch` only runs if `indexing.fetchBeforeIndex: true`.
- Agents get read and MCP tools only. File writes and the shell are denied.
- The agent never types credentials. If the tab shows OneLogin, the run stops and asks you to sign in.
- Planning must not submit forms (set `browser.planObserveOnly: true` to remove input tools entirely). The agent is told to stay within `allowedOrigins`. To have the browser block every other origin, set `browser.enforceAllowedOrigins: true` (Chrome 149+).

## Development

```
bun test             # unit tests and an offline end-to-end run (mock agent + fixtures)
bunx tsc --noEmit    # typecheck
```

For coding agents working on this repo: [`docs/PROJECT.md`](docs/PROJECT.md) is the shared guide (architecture, file index, invariants, status). `CLAUDE.md`, `AGENTS.md` (Codex) and `.github/copilot-instructions.md` all point to it.
