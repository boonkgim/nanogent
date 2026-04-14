# nanogent

A **per-project chat agent** reachable via Telegram, with pluggable tools. Zero runtime npm dependencies. Decentralised by design — every project gets its own listener, its own prompt, its own tool set, its own lifecycle. The whole install lives in **one directory (`.nanogent/`)** you can commit, copy between projects, or delete wholesale.

Requires **Node 24+** — the runtime ships as hand-written TypeScript and relies on Node's built-in type stripping. No build step, no transpiler, no bundler. What you read in `.nanogent/nanogent.ts` is what runs.

By default, nanogent ships with one tool: **`claude`**, which delegates coding tasks to [Claude Code](https://docs.claude.com/claude-code). You can add more tools (`rag`, `search`, `opencode`, etc.) by dropping a folder into `.nanogent/tools/` — the core runtime never needs to change.

```
┌─────────┐     ┌────────────────────────────────────────┐      ┌─────────────┐
│         │     │  nanogent.ts (chat agent)              │      │   claude    │
│Telegram │◀───▶│  ┌──────────────────────────────────┐  │─────▶│  (one tool, │
│         │     │  │ loop: poll → turn → tool dispatch │  │ async│  not core)  │
└─────────┘     │  └──────────────────────────────────┘  │      └─────────────┘
                │         │          │          │        │      ┌─────────────┐
                │         ▼          ▼          ▼        │─────▶│   rag.ts    │
                │       skip       learn    check_job    │      │  (future)   │
                │      (core)      (core)    (core)      │      └─────────────┘
                └────────────────────────────────────────┘      ┌─────────────┐
                         lives inside your project               │  codex.ts   │
                                                                 │   (future)  │
                                                                 └─────────────┘
```

## Two layers, one file per tool

- **Chat agent (core, `nanogent.ts`)** — runs a small Anthropic API loop (Claude Haiku by default) to decide whether to answer the client directly, `skip` side chatter, `learn` a preference, `check_job_status`, `cancel_job`, or delegate to a project-specific tool.
- **Tools (`.nanogent/tools/<name>/`)** — one folder per capability, each with a required `index.ts` that default-exports `{ name, description, input_schema, execute(input, ctx) }`. Long-running tools return `{ async: true, jobId }` immediately and keep the chat agent responsive while they run. When a job finishes, a synthetic `[SYSTEM]` message is injected into the conversation and the chat agent decides how to tell the client.

This is the **open/closed** split: the core is closed for modification; tools are open for extension. Adding a new tool is dropping one file. The core knows nothing about `claude`, `opencode`, `rag`, or anything else specific.

## How nanogent compares

nanogent sits in a crowded space. Here's where it lines up against the closest alternatives — and where it deliberately doesn't.

### vs. Claude Code Channels

Anthropic's [Claude Code Channels](https://code.claude.com/docs/en/channels) pushes messages into a **running** Claude Code session. It's the right tool when you're at your desk with Claude Code open. **nanogent covers the case it doesn't** — when nobody's at the keyboard, when the other end is a client rather than a developer, and when you want a conversational layer above the raw coding agent.

|  | Claude Code Channels | nanogent |
|---|---|---|
| Model | MCP plugin → running Claude Code session | Standalone chat agent → tools (one of which may be `claude`) |
| Requires a live Claude Code session? | **Yes** | No — spawns `claude -p` on demand via the `claude` tool |
| Permission prompts | **Pause remotely** | Bypassed via `--dangerously-skip-permissions` (allowlist gated) |
| Deployable on a VPS / Raspberry Pi / headless box? | Awkward | Yes — `docker compose up -d` |
| Client-facing? | Developer-only | Yes — chat agent handles small talk, skipping, clarification |
| Extensibility | MCP servers | Drop-in folder tools per project |
| Moving parts | MCP server + pairing codes + session | One `.ts` runtime + per-tool folders + `.env` |
| Supported channels | Telegram, Discord, iMessage | Telegram only, by design |

**Use Channels** when you're coding interactively and want a chat-flavored remote for your live session.
**Use nanogent** when you want a per-project assistant you can hand to a client, run on a VPS, or compose with custom tools.

### vs. OpenClaw

OpenClaw ships a full-featured agent gateway with built-in support for many channels, a plugin system, and its own coding execution layer. If you want all of that wired up out of the box, it's a defensible choice. But that choice comes with three costs nanogent refuses to pay:

- **Bloat and audit surface.** You install code for every channel whether you use it or not. That's more surface to audit, more dependencies to maintain, and more attack surface if any channel has a vulnerability. nanogent ships one channel (Telegram) and one default tool; everything else is opt-in via drop-in folders.
- **Centralised gateway creates coupling between projects.** One process owns every project, with a config mapping chat IDs → projects. Moving, duplicating, or removing a project means reconfiguring the gateway — there's no `rm -rf project/.nanogent` equivalent. nanogent is decentralised by design: one project, one listener, one lifecycle.
- **Reinvents existing tools.** OpenClaw builds its own coding execution harness. nanogent prefers to **wrap** existing, well-maintained coding agents (`claude`, `opencode`, `codex`) as tools rather than reimplement them. The Claude Code team writes a better coding harness than we can; we let them.

### vs. NanoClaw

NanoClaw's core is refreshingly small — we agree with that. Where we diverge is its extension model. NanoClaw extends capability via **skills**: natural-language capability descriptions that the LLM interprets at runtime. nanogent takes a different position: **capabilities that have a correct answer should be code, not skills.**

Running a CLI, checking a job status, reading a file, hitting an API with a known schema — these are deterministic tasks with exact inputs and exact outputs. Wrapping them in a natural-language skill description forces an LLM inference every time they fire, which wastes tokens, introduces probabilistic failure modes in places that should be rock-solid, and makes behaviour harder to test and audit. nanogent's tools are JavaScript modules with exact `input_schema` declarations — executed directly by the runtime, not interpreted by a model. The LLM only enters the picture for the routing decision ("is this message for us? which tool should I call? how should I explain the result?"), where probabilistic behaviour is actually the feature.

That's the split: **code for the deterministic, LLMs for the probabilistic.** See the *Tools are code, not skills* design principle below for the positive framing.

## Design principles

nanogent is opinionated. These principles shape every decision in the codebase — what to add, what to refuse, and where to draw the line between core and tools. If you're evaluating nanogent, they tell you the flavour; if you're customising it or writing your own tools, they're the compass for decisions at the margin.

> **Plugin authors and contributors**: the principles below describe nanogent's *character*. For the concrete *design decisions* that follow from them — channel plugin contracts, `chatId` semantics, permission model, email-specific guidance, etc. — see [DESIGN.md](DESIGN.md). That document is the normative reference for anyone writing a new channel, tool, or provider plugin.

**Decentralised — one project, one install, one lifecycle.**
Each project owns its own listener, its own Telegram bot (or allowlisted chat IDs), its own system prompt, its own tool set. No central router, no shared config, no process that knows about every project at once. Start nanogent when you're working on a project, stop it when you're not, `rm -rf .nanogent/` when you're done. Teams running many projects run many nanogent instances — one per project — and each is individually startable, stoppable, and removable. If you find yourself wanting a central control plane, nanogent is the wrong tool.

**Readable over clever.**
The runtime is a single file (`.nanogent/nanogent.ts`) with zero runtime npm dependencies. It uses raw `fetch` against the Anthropic and Telegram APIs instead of pulling in the official SDKs. You should be able to `cat` it and understand the whole thing in one sitting — every tool dispatch, every queue, every piece of state. If a proposed change would make the file materially harder to read in exchange for a minor feature, the change loses.

Node's built-in type stripping (stable since Node 22.6, on by default since 24) erases the TypeScript annotations at parse time — no compilation, no emitted JavaScript, no source map indirection. The file that ships is the file that runs.

**Drop a folder, delete a folder.**
The whole install lives under `.nanogent/`. Nothing nanogent-related lives outside it — no symlinks, no system-wide state, no registry entries, no global npm package. Install is dropping a directory; uninstall is deleting one. Moving a project between machines is `cp -r .nanogent/`. If you're tempted to write state under `~/`, under `/etc/`, or in the user's project root, don't — put it in `.nanogent/`.

**Open/closed core, pluggable tools.**
The core runtime never changes to add capability. New tools are drop-in folders in `.nanogent/tools/<name>/` with a required `index.mjs` that default-exports `{ name, description, input_schema, execute }`. The core scans the tools directory at startup; it has no hardcoded knowledge of `claude`, `opencode`, `rag`, or any other specific tool. If you find yourself editing `nanogent.mjs` to support a new capability, stop — the capability is a tool, not a core change. And if the capability already exists as a well-maintained external tool (a coding agent, a search API, a scheduler), **wrap it rather than reimplement it** — the Claude Code team writes a better coding harness than we can, and the `claude` tool lets them.

**Tools are code, not skills.**
A tool's `execute` function is deterministic JavaScript with an exact `input_schema`, run directly by the runtime — not a natural-language description the LLM interprets at runtime. Capabilities with a correct answer (running a CLI, reading a file, hitting an API with a known schema) belong in code, where they're predictable, cheap to audit, and free of LLM inference. The LLM only decides *which tool to call and how to phrase the result* — that's where probabilistic behaviour is actually the feature. Everywhere else, it's a tax on both tokens and reliability.

**Each tool is standalone.**
A tool imports only from node stdlib and talks to the injected `ctx` — never from sibling tools, a shared helper file, or a tool SDK. Drop a tool folder into another project's `.nanogent/tools/` and it should just work. If you catch yourself wanting to share code between tools, copy it — don't extract it. Three similar files are better than a premature abstraction that won't fit the second implementation when it arrives.

**Core does not dictate tool internals.**
Tools own their own state, their own `.gitignore`, their own persistence decisions. The core's top-level `.gitignore` anchors its rules to core-owned paths (`/state/`, not `state/`) and only adds sensible safety defaults (`.env` at any depth, because silently committing secrets is a failure class that trumps tool autonomy). If a tool wants its state committed to git (e.g. a RAG index that took hours to build), the core doesn't prevent it. If a tool wants its state hidden, the tool ships its own `.gitignore`. The core stays out of that decision.

**Non-blocking by default.**
The chat agent never waits on a long-running tool. Tools that do slow work (spawn a CLI, hit a slow API, run an embedding job) return `{ async: true, jobId }` immediately and register a background promise. The chat agent continues responding to the client — status checks, cancellations, even unrelated questions — while the job runs. When the job finishes, a synthetic `[SYSTEM]` message re-enters the conversation so the chat agent can acknowledge completion. If you're writing a tool that takes more than a couple of seconds, make it async.

**YAGNI beats future-proofing.**
No tool manifests, no versioning fields, no registration files, no helper library, no config schemas, no plugin lifecycle hooks. Every abstraction in nanogent lands only because a concrete use case forced it — and preemptive ones get deleted the moment they're caught. If you're tempted to add a layer for "future flexibility," wait until something concrete demands it.

## Requirements

- **Docker** — `docker` and `docker compose` on PATH. Nanogent always runs the listener inside a container so plugin dependencies stay isolated from the host project.
- **Node.js ≥ 24** on the host for the CLI itself (`nanogent init`, `nanogent build`, `nanogent update`). The runtime inside the container ships its own Node.
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com) (for the chat agent itself)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram chat ID — message [@userinfobot](https://t.me/userinfobot) to get it
- If you keep the default `claude` tool: run `claude` on the host once to complete the login flow so `~/.claude` exists. The container bind-mounts it for auth.

## Install & run

One command drops everything into a single `.nanogent/` directory — your project root stays untouched. Docker is the only runtime; `nanogent start` hands off to `docker compose up --build`.

```bash
cd your-project
npx nanogent init                         # drops .nanogent/ with all plugin folders and builds Dockerfile.generated
cp .nanogent/.env.example .nanogent/.env   # fill in TELEGRAM_BOT_TOKEN + ANTHROPIC_API_KEY
$EDITOR .nanogent/contacts.json            # add yourself as operator with your Telegram chatId
$EDITOR .nanogent/prompt.md                # tailor the system prompt for this project / client
nanogent start                             # docker compose up --build
```

What lands in your project:

```
your-project/
  .nanogent/
    nanogent.ts               ← core runtime (readable, auditable, committed)
    types.d.ts                ← shared plugin contract types — committed
    config.json               ← non-secret settings (projectName, chatModel, maxTokens) — committed
    contacts.json             ← access control + identity map — committed
    prompt.md                 ← system prompt — committed
    Dockerfile                ← base image (FROM / apt) — committed
    Dockerfile.generated      ← produced by `nanogent build` (base + plugin install.sh) — gitignored
    docker-compose.yml        ← what `nanogent start` builds and runs — committed
    .env.example              ← template for secrets — committed
    .env                      ← actual secrets — gitignored via .nanogent/.gitignore
    .gitignore                ← hides .env and state/
    state/                    ← runtime state (jobs, learnings) — gitignored
    tools/
      claude/                 ← default coding tool
        index.ts
        install.sh            ← container-side deps (installs the `claude` CLI); picked up by `nanogent build`
        README.md
    channels/
      telegram/               ← default channel plugin
        index.ts
        README.md
    providers/
      anthropic/              ← default AI provider plugin
        index.ts
        README.md
    history/
      jsonl/                  ← default history store (raw append-only log)
        index.ts
        README.md
    memory/
      naive/                  ← default memory plugin (recent-window retrieval)
        index.ts
        README.md
    scheduler/
      jsonl/                  ← default scheduler plugin (optional; time-based proactive triggers)
        index.ts
        README.md
    tools/
      schedule/               ← agent-facing tool for managing schedules (inert without a scheduler)
        index.ts
        README.md
```

**Your project root is untouched** — nothing nanogent-related lives outside `.nanogent/`. Teams commit `.nanogent/` as a unit to share prompt, tools, and config; runtime state stays local.

### Running in Docker

`nanogent start` always runs `docker compose up --build` against `.nanogent/docker-compose.yml`. The CLI fails fast with an install hint if `docker` isn't on PATH.

**Docker specifics:** the container binds the project root (`..` from `.nanogent/`'s perspective) as `/workspace`, and mounts `~/.claude` + `~/.claude.json` so the `claude` tool can reuse your host auth. The container is the sandbox — `claude` sees only the bind-mounted project root, not the rest of the host filesystem.

**Plugin dependencies in the image:** the core `Dockerfile` is just the base (`FROM node:24-slim` + git/ca-certificates). Any container-side dependency a plugin needs — e.g., the `claude` CLI for `tools/claude` — lives next to that plugin as an `install.sh` script. `nanogent build` walks every plugin folder, finds each `install.sh`, and splices matching `COPY` + `RUN` directives into `.nanogent/Dockerfile.generated`, which is what `docker-compose.yml` actually builds from. `nanogent init` runs the build automatically; `nanogent start` re-runs it if the generated file is missing. Run `nanogent build` by hand after adding, removing, or editing any plugin's `install.sh`. Swapping `tools/claude` for `tools/opencode` (with its own `install.sh`) changes what the image installs without anyone editing the core Dockerfile — see [DR-011](DESIGN.md#dr-011-plugins-inject-container-dependencies-via-installsh).

**Auth on a headless VM:** SSH in, run `claude` once on the host, complete the login flow, and `~/.claude` will exist on the VM. The container reuses it on every boot — no token plumbing required.

**Detached runs:** `cd .nanogent && docker compose up -d --build`. Follow logs with `docker compose logs -f`.

## Configuration

Three files, three concerns:

**`.nanogent/.env`** (secrets — gitignored):

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
ANTHROPIC_API_KEY=sk-ant-...
```

- `TELEGRAM_BOT_TOKEN` — required by the telegram channel plugin
- `ANTHROPIC_API_KEY` — required by the anthropic provider plugin

**`.nanogent/config.json`** (non-secrets — committed):

```json
{
  "projectName": "acme-website",
  "chatModel": "claude-haiku-4-5",
  "maxTokens": 1024
}
```

- `projectName` — identifier for this install; surfaces in logs, system prompt, and tool context
- `chatModel` — Anthropic model for the chat-agent routing layer. Default `claude-haiku-4-5` (cheap + fast)
- `maxTokens` — max output tokens per chat-agent turn

> **Note on `maxHistory`**: v0.4.x had a `maxHistory` knob here. In v0.5.0, windowing is owned by the memory plugin, not the core. Set it via `NANOGENT_MEMORY_WINDOW` (read by `memory/naive`) or swap in a different memory plugin. See [DR-009b](DESIGN.md#dr-009b-memory-is-a-separate-pluggable-indexerretriever-over-history).

**`.nanogent/contacts.json`** (access control + identity — committed):

```json
{
  "alwaysAllowed": ["skip"],
  "users": {
    "alice": { "displayName": "Alice", "tools": ["claude", "learn"] },
    "bob":   { "displayName": "Bob",   "tools": ["claude"] }
  },
  "chats": {
    "alice-dm": {
      "channel": "telegram",
      "chatId":  "12345",
      "displayName": "Alice (DM)",
      "userMapping": { "12345": "alice" },
      "userTools":   ["claude", "learn"],
      "allowGuests": false,
      "historyMode": "shared",
      "mode":        "always",
      "enabled":     true
    },
    "project-group": {
      "channel": "telegram",
      "chatId":  "-1001234567890",
      "userMapping": { "12345": "alice", "67890": "bob" },
      "userTools":   ["claude"],
      "allowGuests": false,
      "historyMode": "shared",
      "mode":        "mention"
    }
  }
}
```

This is the **one file that controls who can reach the bot and what they can do.** The semantics, in short:

- **Unknown `(channel, chatId)` → silent drop + log.** The bot is invisible to anyone not in the allowlist. No tokens spent, no history entry, no response.
- **Known chat → user identified via `chat.userMapping`.** Map platform user IDs (Telegram `from.id`, email address, etc.) to usernames defined in the `users` section.
- **Effective tools = `alwaysAllowed ∪ (user.tools ∩ chat.userTools) ∩ installed`.** Chat-level restrictions intersect with user-level ones. Tools the caller can't invoke are **invisible to the LLM**, not just rejected at call time.
- **Unknown users in known chats** → treated as guests if `allowGuests: true`; silent-dropped otherwise. Guests get `chat.guestTools` only.
- **`mode: mention`** → channel plugin filters at ingress; only messages that `@`-mention the bot (or reply to the bot) are forwarded. Saves tokens on noisy groups.
- **`historyMode: shared`** → one history per chat (right for groups). **`per-user`** → per-(chat, user) histories (right for email inboxes and public helpdesks where senders shouldn't see each other).
- **Wildcard `chatId: "*"`** → matches any chatId in that channel, for open-channel use cases (email inbox, public support).

For deep design rationale — why these specific tradeoffs, how to handle email with multiple recipients, how to write new channel/provider plugins, etc. — see [DESIGN.md](DESIGN.md).

Env vars (`NANOGENT_CHAT_MODEL`, `NANOGENT_MAX_HISTORY`, `NANOGENT_MAX_TOKENS`) still work as one-off overrides without editing the committed config file.

**Already have secrets in a root `.env`?** Nanogent never reads the project's root `.env` — it only looks at `.nanogent/.env`. Three options to avoid duplication:

1. Copy the keys into `.nanogent/.env` (simplest)
2. Symlink: `ln -s ../.env .nanogent/.env`
3. Set them as real environment variables via `docker-compose.yml`'s `environment:` block (or a systemd unit that runs `docker compose up`) — the runtime falls back to `process.env` for every key, so no `.env` file is strictly required

**The system prompt** lives in `.nanogent/prompt.md`. Edit it to describe the project, the client, the tone, and anything specific to this engagement. It's loaded verbatim on every turn (with the stable base cached via Anthropic prompt caching).

### Migrating from 0.2.x

0.2.x dropped files at the project root (`nanogent.mjs`, `.nanogent-prompt.md`) alongside `.nanogent/`. v0.3.0 consolidates everything under `.nanogent/`. To migrate an existing 0.2.x install:

```bash
# preserve your customised prompt
mv .nanogent-prompt.md .nanogent/prompt.md

# drop the old root-level runtime and docker files
rm -f nanogent.mjs Dockerfile docker-compose.yml

# re-run init to drop the new runtime + config.json into .nanogent/
npx nanogent init

# move your secrets into .nanogent/.env
mv .env .nanogent/.env   # or just copy the keys over

# your .nanogent/state/history.jsonl + learnings.md are preserved as-is
```

### Migrating from 0.3.0

v0.3.1 changed tools from single `.mjs` files to folders containing an `index.mjs`, so each tool can own its own README, helpers, and assets. To migrate an existing 0.3.0 install:

```bash
cd .nanogent/tools
for f in *.mjs; do
  [ -e "$f" ] || continue
  name="${f%.mjs}"
  mkdir "$name"
  mv "$f" "$name/index.mjs"
done
```

Your chat history, learnings, prompt, and config are unaffected.

### Migrating from 0.3.1

v0.3.2 tightens the separation between core state and tool state. The core's top-level `.gitignore` now anchors its `state/` rule with a leading slash (`/state/`), so it no longer reaches into tool directories. The default `claude` tool's session marker moves from `.nanogent/state/claude-session.marker` (core state dir) to `.nanogent/tools/claude/state/session.marker` (tool-scoped state), and the tool now ships its own `.gitignore` to hide it.

Optional migration steps (everything works without them — your first claude run after upgrading will just start a fresh session):

```bash
# preserve the existing claude session (optional)
mkdir -p .nanogent/tools/claude/state
[ -f .nanogent/state/claude-session.marker ] && \
  mv .nanogent/state/claude-session.marker .nanogent/tools/claude/state/session.marker

# re-run init to drop the new top-level gitignore + tool gitignore
# (won't overwrite existing files; see `skip (exists)` in output)
npx nanogent init

# update the top-level gitignore manually (init skips the existing one):
# change `state/` to `/state/` in .nanogent/.gitignore
```

Chat history, learnings, prompt, config, and tool code are otherwise unaffected.

### Migrating from 0.3.2

v0.4.0 is the **biggest structural change** since the original release. Telegram and Anthropic move out of the core and into plugin folders. Access control moves out of `.env` and into a new `contacts.json`. Multi-channel support lands. Provider pluggability lands.

The net result from a user's perspective:

- **Everything still lives under `.nanogent/`** — the top-level layout philosophy is unchanged
- **`nanogent.mjs` is still one file you can audit** — ~30 KB, zero npm deps (0.4.x shipped the pre-TS `.mjs` version)
- **Access control is now more powerful and more explicit** — individual users with tool allowlists, per-chat restrictions, silent-drop of unknown chats by default

To migrate an existing 0.3.x install:

```bash
# 1. Preserve your existing prompt, config, and state files (they stay where they are)

# 2. Re-run init to drop the new plugin folders + nanogent.mjs + contacts.json skeleton
#    (won't overwrite existing files — see `skip (exists)` in the output)
npx nanogent init

# 3. Overwrite nanogent.mjs with the new version
rm .nanogent/nanogent.mjs
npx nanogent init

# 4. Fill in contacts.json with your chat details
#    Replace REPLACE_WITH_YOUR_TELEGRAM_CHAT_ID / _USER_ID placeholders
$EDITOR .nanogent/contacts.json

# 5. If you had TELEGRAM_ALLOWED_CHAT_IDS set in .nanogent/.env, remove it —
#    allowlisting is now in contacts.json. Leave TELEGRAM_BOT_TOKEN and
#    ANTHROPIC_API_KEY alone, those are still used.
$EDITOR .nanogent/.env

# 6. Restart — history, learnings, and job state survive the upgrade
nanogent start
```

**Breaking changes worth calling out:**
- `TELEGRAM_ALLOWED_CHAT_IDS` env var is **no longer read**. Move allowlisting to `contacts.json > chats[].userMapping`.
- Chat history is now **keyed by contact** (derived from the chat entry name), not by raw chatId. Existing histories at `.nanogent/state/history.jsonl` are not automatically migrated — they'll sit there unused. Move them manually to `.nanogent/state/history/<chat-key>.jsonl` if you want to preserve context.
- The default runtime requires **`contacts.json`** to exist. Without it or with an empty chats section, every incoming message is dropped as unknown.

**Philosophical changes** (see [DESIGN.md](DESIGN.md) for details):
- Telegram is now a drop-in channel plugin at `.nanogent/channels/telegram/index.mjs`. You can replace it.
- Anthropic is now a drop-in provider plugin at `.nanogent/providers/anthropic/index.mjs`. You can replace it.
- Permissions are declared in `contacts.json`, not inside tool files. See DESIGN.md § DR-005.
- User messages are always prefixed with `[displayName]:` for group chat attribution. See DESIGN.md § DR-003.

### Migrating from 0.4.x

v0.5.0 converts everything to TypeScript. The runtime still ships as a single hand-written file; the difference is that it now has type annotations, and Node strips them at parse time. **Nothing about the deployment model, `contacts.json` shape, or plugin contract changed** — the code is the same shape, just with types.

**Requires Node 24+.** Node 22 and earlier cannot run `.ts` files directly. If you're stuck on an older Node, pin to the `0.4.x` release.

```bash
# 1. Upgrade Node to 24+ if needed
node --version   # should print v24.x.x

# 2. Update nanogent itself
npm install -g nanogent@latest   # or your preferred install method

# 3. Run the update — it drops the new .ts core runtime and a shared types.d.ts,
#    and preserves your prompt / config / contacts / locally-modified plugins
nanogent update

# 4. The old .mjs files under .nanogent/ are stale — delete them by hand.
#    `nanogent update` never removes files it didn't ship this version, so the
#    old extensions must be cleaned up manually:
rm -f .nanogent/nanogent.mjs
rm -f .nanogent/tools/claude/index.mjs
rm -f .nanogent/channels/telegram/index.mjs
rm -f .nanogent/providers/anthropic/index.mjs

# 5. Restart — history, learnings, and job state survive
nanogent start
```

**If you hand-modified any plugin `index.mjs` file**, port those changes to the new `index.ts` before deleting the `.mjs`. `nanogent update` will skip updating a locally-modified `.mjs` → `.ts` plugin since the byte-compare check fails on a file that doesn't exist yet — so you'll see the new `.ts` version dropped cleanly, and your custom `.mjs` sitting alongside, ignored. Diff them by hand and port.

**Plugin author note:** if you wrote a custom tool / channel / provider, rename `index.mjs` → `index.ts` and add types by importing from `../../types.d.ts`. See the shipped plugins for reference.

### Migrating from 0.5.0

v0.6.0 splits history storage and memory retrieval into two separate plugin directories. The core no longer reads or writes history files directly — everything goes through `history/<name>/` (raw append-only log) and `memory/<name>/` (indexer + retriever). This unlocks pluggable memory systems: vector RAG, GraphRAG, summarisation, mem0-style memories, etc. See [DESIGN.md DR-009a/b](DESIGN.md#dr-009a-history-storage-is-a-separate-pluggable-raw-log-concern) for the full rationale.

**The default plugins (`history/jsonl` + `memory/naive`) preserve v0.5.0 behaviour byte-for-byte.** Existing `.nanogent/state/history/*.jsonl` files are read unchanged — no data migration needed.

```bash
# 1. Update nanogent
npm install -g nanogent@latest

# 2. Run the update — it drops the new history/jsonl and memory/naive plugins,
#    and updates the core to the pluggable version. Config / contacts / prompt
#    are preserved as always.
nanogent update

# 3. Restart — history and learnings survive
nanogent start
```

**Breaking changes worth calling out:**

- Two new **required** plugin directories: `.nanogent/history/` and `.nanogent/memory/`. Exactly one plugin must live in each, or the runtime exits at startup. `nanogent update` drops the defaults automatically.
- `config.json`'s `maxHistory` field is **no longer read** by the core. Windowing is now a memory-plugin concern. To tune the default window, set `NANOGENT_MEMORY_WINDOW=N` in `.env`, or swap `memory/naive` for a smarter memory plugin.
- The `rotateHistory` / `isTurnStart` helpers moved from `nanogent.ts` to `memory/naive/index.ts`. If you imported them in a custom test file or plugin, update the import path.

**Why this is worth it:**

- You can now swap in vector RAG, GraphRAG, or mem0-style memories without touching the core or losing history
- History is a portable audit trail — operators can `cat` `.nanogent/state/history/*.jsonl` regardless of which memory system is active
- Memory indices are recoverable: drop the index, replay `append` from history, rebuild

See the new READMEs at [`.nanogent/history/jsonl/`](template/history/jsonl/README.md) and [`.nanogent/memory/naive/`](template/memory/naive/README.md) for plugin-author guidance.

### Migrating from 0.6.0

v0.7.0 introduces an **optional** new plugin type: `scheduler`. Unlike history/memory, the runtime does not require a scheduler — projects that don't need proactive/time-based triggers can ignore everything in this section and keep running exactly as before. No config changes, no breaking changes.

What v0.7.0 adds:

- A new `.nanogent/scheduler/<name>/` plugin directory (zero or one active).
- A new bundled `scheduler/jsonl` default that stores schedule definitions in `state/schedules.json` and an append-only execution log in `state/schedule-log.jsonl`.
- A new bundled agent-facing `tools/schedule` tool with three actions (`create` / `list` / `cancel`) the agent calls conversationally.
- A new core `fireSystemTurn` helper exposed from `nanogent.ts` — the single entry point for non-user-initiated turns. The scheduler tick loop uses it today; future webhook channels or tool completion bridges can reuse it.
- A once-a-minute scheduler tick loop in core that runs only when a scheduler plugin is loaded.

```bash
# 1. Update nanogent
npm install -g nanogent@latest

# 2. Run the update — it drops the new scheduler/jsonl plugin and the
#    tools/schedule agent tool, and updates the core with the new tick loop
#    and fireSystemTurn helper. Config / contacts / prompt / existing plugins
#    are preserved as always.
nanogent update

# 3. Restart
nanogent start
```

**Supported schedule string formats** (all UTC — convert from the user's local wall clock before passing to the tool):

| Format              | Meaning                                | Example                        |
|---------------------|----------------------------------------|--------------------------------|
| `once@<ISO-UTC>`    | One-shot, fires once.                  | `once@2026-04-15T18:00:00Z`    |
| `daily@HH:MM`       | Every day at HH:MM UTC.                | `daily@08:00`                  |
| `every@<seconds>`   | Every N seconds from creation.         | `every@3600` (hourly)          |

**If you don't want scheduling**, delete the scheduler plugin directory after running `nanogent update`:

```bash
rm -rf .nanogent/scheduler
# The tools/schedule tool stays but returns a clear "no scheduler installed"
# error if the agent ever calls it. Or remove it too:
rm -rf .nanogent/tools/schedule
```

**Breaking changes:** none. The runtime boots fine with zero schedulers and the core tick loop is a no-op in that state.

**Philosophical notes:**

- Schedules are stored under `state/`, not `config.json`. They're mutable agent-owned runtime state, not operator-authored configuration. Same category as history.
- The definitions file and the execution log are deliberately separate. Definitions change only on explicit CRUD; the log grows monotonically as schedules fire. This mirrors the event-sourcing shape already used for history/memory.
- Scheduler is one plugin, not two (`schedule-store` + `schedule-queue`) — the two concerns are tightly coupled and always ship together. A sqlite scheduler wants both in the same file; a redis scheduler wants both in the same keyspace.
- The agent creates schedules conversationally through the `schedule` tool. There's no terminal command to edit schedules directly — use the chat, or edit `state/schedules.json` by hand if you really need to.

See [`.nanogent/scheduler/jsonl/README.md`](template/scheduler/jsonl/README.md), [`.nanogent/tools/schedule/README.md`](template/tools/schedule/README.md), and [DESIGN.md DR-010](DESIGN.md#dr-010-scheduler-is-an-optional-pluggable-proactive-trigger-source) for plugin-author guidance and the full rationale.

### Migrating from 0.7.0

v0.8.0 makes container dependencies pluggable. Until 0.7.0, the core `Dockerfile` hard-coded `npm install -g @anthropic-ai/claude-code`, so swapping `tools/claude` for a different coding tool meant editing the core Dockerfile — a clean OCP violation. v0.8.0 moves that install out of core and into `tools/claude/install.sh`, and adds a new `nanogent build` step that composes the real `Dockerfile.generated` from the base Dockerfile plus every plugin's optional `install.sh`.

What v0.8.0 adds:

- A new `nanogent build` CLI command. Scans `.nanogent/{tools,channels,providers,history,memory,scheduler}/*/install.sh` and writes `.nanogent/Dockerfile.generated`.
- A base Dockerfile that ships only `FROM node:24-slim` + `git` + `ca-certificates`, with a `# __NANOGENT_PLUGIN_INSTALLS__` marker where plugin installs are spliced in. Edit it to change the FROM image or baseline apt packages; leave the marker line intact.
- A new `tools/claude/install.sh` that installs the `claude` CLI. This is the *only* file that owns the `@anthropic-ai/claude-code` dependency now.
- `docker-compose.yml` builds from `Dockerfile.generated` instead of `Dockerfile`. `Dockerfile.generated` is gitignored as a build artifact.
- `nanogent init` auto-runs build at the end so fresh installs are immediately docker-ready.
- `nanogent start` auto-runs build if `Dockerfile.generated` is missing — so one-shot starts on a fresh checkout "just work".

```bash
# 1. Update nanogent
npm install -g nanogent@latest

# 2. Run the update. Plugin files (including the new tools/claude/install.sh)
#    are dropped in if missing, or preserved if you've edited them locally.
#    The base Dockerfile and docker-compose.yml are code files and will be
#    overwritten — that's what you want.
nanogent update

# 3. Regenerate Dockerfile.generated with the new install step.
nanogent build

# 4. Restart (docker mode rebuilds the image from the generated Dockerfile).
nanogent start
```

**Breaking changes:** the image tag has to be rebuilt because the Dockerfile shape changed. `nanogent start` passes `--build` to compose, so it handles this automatically.

**Philosophical notes:**

- The core Dockerfile is *open for extension, closed for modification*. Adding a new tool that needs `go`, `rust`, `pandoc`, or a Python wheel means shipping an `install.sh` in the plugin folder, not editing core.
- Plugin `install.sh` runs as root during `docker compose build`. This is a meaningful trust surface — only install plugins whose `install.sh` you would be comfortable running as root inside your build context.
- `Dockerfile.generated` is a derived artifact, like `package-lock.json` for Docker. It's content-addressed by plugin discovery order (fixed: `tools`, `channels`, `providers`, `history`, `memory`, `scheduler`) so Docker's layer cache survives across unrelated plugin additions.
- Build is pure file-generation — no docker daemon needed to run `nanogent build` itself.

See [DESIGN.md DR-011](DESIGN.md#dr-011-plugins-inject-container-dependencies-via-installsh) for the full rationale and plugin-author checklist.

### Migrating from 0.8.0

v0.8.1 is a non-breaking follow-up to v0.8.0 that adds an **optional** per-plugin container-resource advisory. Nothing in v0.8.0 stops working; if you don't need it, you can ignore everything in this section and `nanogent update` is a no-op.

What v0.8.1 adds:

- Plugins can now ship an optional `resources.json` next to `install.sh` with any of `minMemoryMb`, `minCpus`, `note`.
- `nanogent build` discovers every `resources.json`, aggregates across all plugins using `max()` (plugins share one container, so the floor is the hungriest plugin's floor — not the sum), and prints an advisory block at the end of the build naming the hungriest plugin for each dimension.
- The advisory also checks whether `.nanogent/docker-compose.yml` already declares `mem_limit` / `cpus` / `deploy:` — if it doesn't, the operator gets a one-line nudge to add limits there. If it does, the operator gets a one-line reminder to verify the values meet the floor.
- No file is ever edited. `docker-compose.yml` stays operator-owned. The advisory is pure hint, nothing more.
- Missing, malformed, or partial `resources.json` files never fail the build — discovery warns and skips.

Example `resources.json` for a plugin that ships an LSP server:

```json
{
  "minMemoryMb": 4096,
  "minCpus": 2,
  "note": "rust-analyzer LSP + cargo metadata indexing"
}
```

What v0.8.0 plugins should do: **probably nothing**. Only ship a `resources.json` if your plugin has a *real* floor that would cause confusing failures (OOM kills mid-turn, runaway CPU thrashing) on a default-sized container. The default claude tool doesn't ship one because it's a CLI shell-out with no meaningful floor — shipping one there would just nag everyone for no reason.

```bash
# 1. Update nanogent
npm install -g nanogent@latest
nanogent update

# 2. Regenerate Dockerfile.generated (unchanged by the update, but this
#    is when new resources.json advisories would light up if you add one).
nanogent build
```

### Migrating from 0.8.1

v0.9.0 makes **Docker the only supported runtime**. The host `node` path (and the `--node` / `--docker` start flags + the `docker` field in `config.json`) is gone. Rationale: plugin `install.sh` scripts can `apt-get`, `npm install -g`, and write to system paths — running those on the host is exactly the pollution Docker was added to prevent. Making Docker mandatory eliminates a dual-install contract and collapses the test matrix.

What changed:

- `nanogent start` always runs `docker compose up --build`. The `--node` and `--docker` flags are gone.
- `.nanogent/config.json` no longer has a `docker` field. The `Config` type in `types.d.ts` no longer declares it.
- The CLI fails fast with an install hint if `docker` isn't on PATH.
- The host machine still needs Node ≥ 24 for the CLI itself (`init`, `build`, `update`), but the runtime inside the container ships its own Node.

```bash
# 1. Update nanogent
npm install -g nanogent@latest
nanogent update

# 2. Remove the now-ignored `docker` field from .nanogent/config.json
$EDITOR .nanogent/config.json

# 3. Start — docker compose up --build, always
nanogent start
```

### Migrating from 0.9.0

v0.10.0 **decouples core and plugin installation**. Core knows nothing about any specific plugin name; every installable plugin ships a required `plugin.json`; the default plugin set moves from a hardcoded array inside `bin/cli.ts` into `template/profiles/default.json` (data, not code); and a new `nanogent plugin add/remove/list` subcommand gives third-party plugins a first-class lifecycle. See [DESIGN.md DR-013](./DESIGN.md#dr-013-core-and-plugin-installation-are-decoupled--plugins-are-self-describing-defaults-are-data) for the full rationale.

What's new:

- **`plugin.json` is required** on every installable plugin. Minimal shape:
  ```json
  {
    "name": "claude",
    "type": "tools",
    "description": "Delegate tool calls to Claude Code CLI",
    "files": ["index.ts", "README.md", "install.sh", "gitignore"]
  }
  ```
  `type` is one of `tools`, `channels`, `providers`, `history`, `memory`, `scheduler`. `files` is optional — if omitted, the installer copies every non-hidden top-level file in the plugin dir. Declare it explicitly if your plugin ships a `gitignore` (renamed to `.gitignore` on install) or any other file that'd otherwise be hidden from the default walker.
- **`nanogent plugin list` / `add <path>` / `remove <name>`** is the new lifecycle subcommand. `add` takes a local path to any directory with a valid `plugin.json`; remove takes a plugin `name` and prompts for confirmation unless `-f` is passed. Third-party plugins install through the exact same code path as shipped defaults.
- **`nanogent init --profile <path>`** lets operators author their own profile files to ship an opinionated plugin set for a team. The default profile is `template/profiles/default.json` (seven plugins: the existing defaults), and a `minimal.json` ships too (zero plugins — a core-only skeleton for operators who want to author everything from scratch).
- **Filename conventions** (the two workarounds for `npm pack`): a file literally named `gitignore` is copied as `.gitignore`, and `install.sh` is chmod'd to `0o755` after copy. These are applied automatically — you just write the file.
- **`bin/cli.ts` no longer names any specific plugin.** Grep it for `claude`, `telegram`, `anthropic`, `jsonl`, `naive`, `schedule` — none appear. The vocabulary is generic (`PLUGIN_TYPES` and the profile file).

Breaking change: existing v0.9.0 `.nanogent/` installations don't have a `plugin.json` in each plugin dir, so `nanogent plugin list` and phase-2 of `nanogent update` will log a warning and skip each plugin. Two migration options:

```bash
# Option A — clean re-init (if you haven't customised any plugin files)
rm -rf .nanogent
npm install -g nanogent@latest
nanogent init

# Option B — hand-author a plugin.json per plugin dir (if you have local edits worth preserving)
npm install -g nanogent@latest
# For each plugin dir under .nanogent/tools, channels, providers, history, memory, scheduler:
cat > .nanogent/tools/claude/plugin.json <<'EOF'
{ "name": "claude", "type": "tools", "files": ["index.ts", "README.md", "install.sh", "gitignore"] }
EOF
# ... then:
nanogent update
nanogent start
```

For plugins that don't ship a renamed file (everything except `tools/claude` in the default set), the `files` field can be omitted:

```json
{ "name": "telegram", "type": "channels", "description": "Telegram bot transport" }
```

Once running, a client just sends any text to the bot. The chat agent:

1. Decides whether the message is addressed to it (calls `skip` if not)
2. Answers directly if it can (small talk, clarifications, restating prior tool results)
3. Delegates to the right tool if it can't — most commonly, calls `claude` with a self-contained coding prompt
4. Tells the client *"on it — I'll let you know when it's done"*, and the actual work runs in the background
5. When the background job finishes, the chat agent gets notified and sends a completion message — which Telegram pushes to the client's phone as a notification

Operators also have a few slash commands that bypass the LLM entirely:

| Command | Description |
|---|---|
| *(any text)* | Routed through the chat agent |
| `/status` | Show the current background job (if any) |
| `/cancel` | Cancel the running background job |
| `/clear` | Wipe chat history — next message starts a fresh conversation |
| `/help` | Show command list |

Slash commands are cheap and instant (no LLM call); they operate directly on the runtime's own state.

## Adding a tool

A tool is a **folder** in `.nanogent/tools/` with two required files: `plugin.json` (metadata) and `index.ts` (the tool object). Everything else in the folder — helpers, assets, schemas, README, tests — is the tool's own business.

```
.nanogent/tools/
  claude/
    plugin.json      ← REQUIRED. { "name": "claude", "type": "tools", ... }
    index.ts         ← REQUIRED. Default-exports the tool object.
    README.md        ← recommended — setup notes, API keys, example invocations.
  rag/               ← example of a folder-shaped tool that outgrew one file
    plugin.json
    index.ts
    README.md
    chunker.ts       ← helpers the tool imports via normal relative imports
    schemas/
      answer.json
```

A minimum-viable `plugin.json`:

```json
{
  "name": "rag",
  "type": "tools",
  "description": "Answer a question by searching the project's knowledge base"
}
```

`type` decides where the plugin lives on disk (`tools`, `channels`, `providers`, `history`, `memory`, `scheduler`); `name` must match the directory name. `files` is optional — when omitted, the installer copies every non-hidden top-level file in the plugin dir. See [DESIGN.md DR-013](./DESIGN.md#dr-013-core-and-plugin-installation-are-decoupled--plugins-are-self-describing-defaults-are-data) for the full manifest contract.

Minimum viable tool — `rag/index.ts`:

```ts
import type { ToolCtx, ToolPlugin } from '../../types.d.ts';

const plugin: ToolPlugin = {
  name: 'rag',
  description: 'Answer a question by searching the project\'s knowledge base.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The question to answer.' },
    },
    required: ['query'],
  },
  async execute({ query }: { query?: string }, ctx: ToolCtx) {
    // Sync fast tool — just return the result.
    const answer = await searchKnowledgeBase(query ?? '');
    return { content: answer };
  },
};

export default plugin;
```

Plain JavaScript works too — if you'd rather skip the types, write `export default { ... }` directly and rename the file to `.ts` with no annotations. Node strips nothing and runs it as-is. But the shared types in `.nanogent/types.d.ts` catch a lot of mistakes at author time, and cost nothing at runtime.

For **long-running tools** (spawning a CLI, hitting a slow API, doing anything that takes more than a couple of seconds), return immediately with a job id and register a background promise:

```js
async execute({ prompt, title }, ctx) {
  if (ctx.busy()) return { content: 'error: another job is running' };
  const jobId = ctx.newJobId();
  const child = spawn('opencode', ['...', prompt], { cwd: ctx.projectDir });
  const donePromise = new Promise(resolve => child.on('close', () => resolve('done')));
  const cancel = () => child.kill('SIGTERM');
  ctx.backgroundJob(jobId, donePromise, cancel, { toolName: 'opencode', title });
  return {
    async: true,
    jobId,
    content: `Started '${title}' (id=${jobId}). Tell the user you're working on it.`,
  };
},
```

**Reading sibling files** (assets, schemas, cached indexes) uses `ctx.toolDir`:

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

async execute({ query }, ctx) {
  const schema = JSON.parse(readFileSync(join(ctx.toolDir, 'schemas/answer.json'), 'utf8'));
  // ... use schema
}
```

What `ctx` provides:

| | |
|---|---|
| `ctx.projectDir` | Project root (cwd) — this is where the shell runs tools like `claude -p` |
| `ctx.toolDir` | Absolute path to *this tool's* folder — read sibling files from here |
| `ctx.chatId` | Telegram chat the request came from |
| `ctx.sendMessage(text)` | Post a new Telegram message |
| `ctx.editMessage(msgId, text)` | Edit a message the tool previously sent |
| `ctx.newJobId()` | Generate a new job id |
| `ctx.backgroundJob(id, promise, cancelFn, meta)` | Register a long-running job |
| `ctx.busy()` | Returns `null` or the currently-running job descriptor |
| `ctx.log(...)` | Scoped logger |

Tools are discovered at startup by scanning `.nanogent/tools/` for directories. Each directory must contain an `index.ts` that default-exports `{ name, description, input_schema, execute }` — if the file is missing or the shape is wrong, the tool is skipped with a log line. Directories starting with `_` are ignored (scratch / wip space). No manifest, no config file, no naming rules beyond `index.ts` — drop a folder, restart, it's loaded.

### State & persistence

Each tool owns its own directory under `.nanogent/tools/<name>/`. **That includes any state the tool wants to persist** — caches, indexes, session markers, whatever. The convention (not enforcement) is to put it under `ctx.toolDir/state/`:

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async execute(input, ctx) {
  const stateDir = join(ctx.toolDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'cache.json'), JSON.stringify(data));
  // ...
}
```

**Core does not dictate what tools commit or ignore.** Nanogent's top-level `.nanogent/.gitignore` only hides things the core owns:

- `.env` (at any depth) — safety default; any `.env` file anywhere under `.nanogent/` is treated as secret
- `/state/` (anchored with a leading slash) — the core runtime's own state directory only

That anchored `/state/` rule does **not** reach into `.nanogent/tools/<name>/state/`. Whether your tool's state is committed is entirely your tool's decision:

- **Tool wants its state committed** (e.g. a RAG tool with a pre-built index that took hours to build and the team should share): ship no `.gitignore`, or a `.gitignore` that explicitly un-ignores `state/`.
- **Tool wants its state hidden** (e.g. per-machine session markers, temporary caches): ship a `.gitignore` inside the tool's folder, e.g. `.nanogent/tools/<name>/.gitignore` containing `state/`.

The default `claude` tool is the second case — it ships `.nanogent/tools/claude/.gitignore` with `state/` so its session marker isn't committed. Read it as a reference if you're writing a new tool.

**Nothing about core changes when you add a tool with state.** No new config, no registration, no opt-in. `ctx.toolDir` is always defined, `mkdir + write` is all the API you need, and the gitignore story is the tool's problem.

## Managing plugins

Same lifecycle applies to every plugin type — tools, channels, providers, history, memory, scheduler. `nanogent init` installs the plugins listed in the active profile (default: `template/profiles/default.json`), and after that `nanogent plugin` manages anything you want to add or remove:

```bash
nanogent plugin list                 # what's installed, with descriptions
nanogent plugin add ./path/to/dir    # install a local plugin (needs a plugin.json)
nanogent plugin add ~/my-tool --force  # overwrite an existing install
nanogent plugin remove schedule      # prompts; -f to skip confirmation
```

`plugin add` resolves the ref, validates `plugin.json`, copies files to `.nanogent/<type>/<name>/`, applies the `gitignore → .gitignore` rename and the `install.sh` chmod, then re-runs `nanogent build` so any new `install.sh` makes it into the next image build. Third-party plugins install through exactly the same code path as the shipped defaults — no second-class citizens.

**Profiles** are JSON files listing plugin refs relative to the profile file's directory:

```bash
nanogent init --profile ./team-profiles/minimal.json
```

Ship an opinionated profile alongside your project (git-tracked, reviewable, diffable) and every `nanogent init` drops the same plugin set. The two profiles bundled with the CLI — `default.json` (the seven current defaults) and `minimal.json` (zero plugins — core only) — live under `template/profiles/` in the installed package and can be used as starting points.

## How it works

1. **Long-poll Telegram.** No webhook, no inbound ports.
2. **Slash commands** (`/status`, `/cancel`, `/clear`) run directly against the runtime's state — no LLM call.
3. **Normal messages** get enqueued as "turn triggers". A worker processes triggers one at a time per project (so conversation stays coherent), running a **chat-agent turn** against the Anthropic API.
4. **Each turn** builds the system prompt from `.nanogent-prompt.md` + learnings + current job state, passes the full history + the union of core tools + plugin tool schemas, and runs the tool-use loop until the model returns `stop_reason: end_turn`.
5. **Tool calls** during a turn are dispatched to the right tool's `execute`. Sync tools return inline. Async tools register a background job and return immediately — the turn ends quickly with a "working on it" message.
6. **Background jobs** resolve on their own timeline. On completion, the runtime enqueues a synthetic `[SYSTEM]` trigger (`Tool 'claude' (job abc, "make header darker") completed after 47s: ...`), and the worker runs a fresh chat-agent turn on it. The model sees the result and decides what to say to the client — usually sends a completion message, which Telegram pushes as a notification.
7. **Chat history** persists to `.nanogent/state/history.jsonl`, loaded on startup. Learnings persist to `.nanogent/state/learnings.md`. Both survive restarts, redeployments, and container rebuilds.

The chat agent itself is ~20 LOC of Anthropic API loop + a small tool dispatch table. Everything else is plumbing (Telegram, history, learnings, job registry, slash commands).

## Updating, stopping & removing

### Updating to a newer nanogent version

```bash
nanogent update              # update runtime; preserve your prompt, config, contacts, and local plugin edits
nanogent update --force      # also overwrite locally-modified plugin files
nanogent update --dry-run    # preview what would change, without touching files
```

`nanogent update` knows the difference between three kinds of files in `.nanogent/`:

- **Core code** (`nanogent.ts`, `types.d.ts`, `Dockerfile`, `docker-compose.yml`, `.env.example`) — always overwritten. No one should be customising these.
- **Installed plugins** — phase 2 walks every `.nanogent/<type>/<name>/` dir that ships a `plugin.json`, tries to re-resolve against the shipped source, and for each file byte-compares local vs shipped. Unmodified files get the new shipped version; locally-modified files are skipped with a message like:
  ```
  skipped:  .nanogent/tools/claude/index.ts (locally modified — pass --force to overwrite)
  ```
  and a `diff` command hint comparing your version against the shipped one. Pass `--force` if you actually want to reset a customisation. Third-party plugins installed via `nanogent plugin add` are logged as `skipped: ... (no shipped source — third-party plugin)` and left alone.
- **User config** (`prompt.md`, `config.json`, `contacts.json`, `.env`, `.gitignore`) — **never touched**. These are yours.

New files introduced in a version bump are always created, regardless of type.

**Typical upgrade flow:**

```bash
# preview first
nanogent update --dry-run

# then apply
nanogent update

# restart the listener if it was running
# (Ctrl+C the old process, start it fresh)
nanogent start
```

Your chat history, learnings, and job state all live in `.nanogent/state/` and are never touched by update.

> **Note**: `nanogent update` handles compatible upgrades (e.g., v0.4.0 → v0.4.1). **Breaking releases** (e.g., v0.3.x → v0.4.0) still need their own manual migration steps — see the `Migrating from 0.x` sections earlier in this README.

### Stopping

```bash
Ctrl+C                              # if started in the foreground via `nanogent start`
cd .nanogent && docker compose down # for detached runs
```

### Fully removing from a project

```bash
nanogent uninstall                 # confirms, then deletes .nanogent/
nanogent uninstall -f              # same, skip confirmation
# or manually:
rm -rf .nanogent
```

Uninstalling is deleting one directory. That's still the whole point.

## Security notes

- **`--dangerously-skip-permissions`** is passed to the `claude` tool so it can run without interactive prompts. That means anyone listed in `.nanogent/contacts.json` with `claude` in their effective tool set can trigger arbitrary shell work in the project directory via the chat agent. **Only use it in projects you trust with chats you trust.** For a hard sandbox, use the Docker option — the container can only see the bind-mounted `/workspace` and the mounted Claude auth.
- **Always populate `contacts.json`** before starting. An empty `contacts.json` means every incoming message is dropped as unknown — which is the safe default, but no legitimate users can reach the bot either. Add yourself (the operator) as the first entry.
- **Unknown `(channel, chatId)` pairs are silent-dropped** — the bot is invisible to anyone not explicitly allowlisted. No response, no token use, no history entry. See logs for dropped-contact attempts.
- Use a **separate bot token per project** for hard isolation. Telegram bot tokens are free and unlimited.
- **Two cost centers.** Every message costs Anthropic API tokens for the chat agent (usually ~1k input tokens at Haiku rates), *plus* the cost of whichever tool runs. The chat agent is intentionally cheap so small talk doesn't break the bank.
- Treat `.env` like any other secret file — add it to `.gitignore`.

## FAQ

**Why is the chat agent separate from Claude Code? Isn't Claude Code already an agent?**
Yes, but Claude Code is the *coding* agent — it's expensive, slow, and designed to do real file-system work. nanogent's chat agent sits above it as a cheap, fast routing layer that handles small talk, clarification, `skip`, status checks, and decides whether a message actually needs the coding agent at all. That saves tokens, saves time, and lets you swap the coding backend (opencode, codex, gemini, your own CLI) without touching the conversation layer.

**Can I run nanogent without the `claude` tool?**
Yes. Delete `.nanogent/tools/claude/` and nanogent becomes a pure chat bot with whatever other tools you have (or none at all — `skip` + `learn` + `check_job_status` + `cancel_job` still work for small-talk-only setups).

**Can I have multiple coding tools at once (e.g. `claude` + `opencode`)?**
Yes. Both tool files live side-by-side in `.nanogent/tools/`. Tell the chat agent in `.nanogent-prompt.md` which tool to prefer for which kinds of tasks (e.g. *"use `claude` for TypeScript, `opencode` for Python data work"*). Tools don't know about each other; the chat agent routes.

**Does the chat agent remember things across restarts?**
Yes. Chat history persists to `.nanogent/state/history.jsonl`, and learnings persist to `.nanogent/state/learnings.md`. If the process (or container) restarts, the conversation continues where it left off.

**What if my message lands while a background job is running?**
The chat agent handles it. It can answer directly, call `check_job_status`, call `cancel_job` to switch directions, or refuse to start a second job of the same kind. The runtime only enforces one background job at a time — how to handle a busy state is the chat agent's decision.

**Does it support WhatsApp / Discord / Slack?**
No. Telegram only, by design. If you need Discord or iMessage, [Claude Code Channels](https://code.claude.com/docs/en/channels) already covers those. Fork and swap the transport if you want another channel here.

**Can I run multiple projects at once?**
Yes — each project runs its own `nanogent.ts`. Give each one its own bot token (or at least its own allowlisted chat) so messages don't cross wires.

## Development

This is only relevant if you're hacking on nanogent itself (cloning this repo, not installing the npm package).

```bash
git clone https://github.com/boonkgim/nanogent.git
cd nanogent
npm install          # installs typescript + eslint + @types/node (dev-only)
npm run typecheck    # tsc --noEmit against bin/, template/, tests/
npm run lint         # eslint .
npm test             # node:test against tests/
```

- **Runtime still has zero npm dependencies.** `npm install` only pulls devDependencies for the toolchain. The `template/` directory — what ships to users via `nanogent init` — imports nothing outside the Node stdlib.
- **No build step.** There is no `dist/`, no compiled output, no emitted JavaScript. `tsc` is used in `--noEmit` mode just for typecheck. Node runs the `.ts` files directly via built-in type stripping.
- **Tests use `node:test`** (built into Node) plus real temp directories via `fs.mkdtempSync`. No mocking framework, no test runner dependency.
- **Pure helpers are exported from `template/nanogent.ts`** for testability: `findChat`, `resolveAccess`, `rotateHistory`, `isTurnStart`, `loadEnv`, `loadConfig`, `loadContacts`. The file is side-effect-free on import — actual runtime bootstrap only happens when the file is executed directly, so tests can import it cleanly.

### Runtime testing against a live Telegram bot

`npm test` covers the pure helpers, but it doesn't actually boot the runtime or talk to Telegram / Anthropic. When you're iterating on the core loop, a plugin, or a prompt change and you want to exercise the real thing end-to-end, set up a scratch project outside the repo with symlinks back into `template/` so edits take effect on restart without a copy step.

The runtime hardcodes paths under `.nanogent/` relative to `process.cwd()`, so there's no way to run `template/nanogent.ts` in place — you need a directory containing a `.nanogent/` folder to launch from.

```bash
mkdir -p /tmp/ng-dev/.nanogent && cd /tmp/ng-dev
REPO=~/codes/nanogent/template

# Symlink code + plugin dirs so template/ edits are picked up on restart
ln -s $REPO/nanogent.ts      .nanogent/nanogent.ts
ln -s $REPO/types.d.ts       .nanogent/types.d.ts
ln -s $REPO/Dockerfile       .nanogent/Dockerfile
ln -s $REPO/docker-compose.yml .nanogent/docker-compose.yml
ln -s $REPO/tools            .nanogent/tools
ln -s $REPO/channels         .nanogent/channels
ln -s $REPO/providers        .nanogent/providers
ln -s $REPO/history          .nanogent/history
ln -s $REPO/memory           .nanogent/memory
ln -s $REPO/scheduler        .nanogent/scheduler

# Copy user-owned files so you can customise without dirtying the repo
cp $REPO/prompt.md     .nanogent/prompt.md
cp $REPO/config.json   .nanogent/config.json
cp $REPO/contacts.json .nanogent/contacts.json
cp $REPO/.env.example  .nanogent/.env   # then fill TELEGRAM_BOT_TOKEN + ANTHROPIC_API_KEY

# For a fast dev loop, bypass the CLI and run the runtime directly on the host
# (skips docker build). This is a *dev shortcut only* — end users must run in
# docker via `nanogent start`. You're responsible for any host-side deps the
# plugins you're testing would normally install via install.sh.
node .nanogent/nanogent.ts

# For an end-to-end docker run, use the CLI as a user would:
nanogent build    # regenerates .nanogent/Dockerfile.generated from the symlinks
nanogent start    # docker compose up --build
```

Now you can edit anything under `template/` in your editor, Ctrl+C the process, relaunch, and the changes are live — no `nanogent update`, no copy step, no byte-compare skip. All mutable state (`.nanogent/state/`, history JSONL, memory files) lands in `/tmp/ng-dev/`, so the repo working tree stays clean. To reset: `rm -rf /tmp/ng-dev`.

Use a **throwaway bot token** and a bot that only you can message. If you add a new file or plugin directory under `template/`, remember to add a matching symlink in the scratch dir.

## License

[MIT](./LICENSE) © Khur Boon Kgim
