# nanogent

A **per-project chat agent** reachable via Telegram, with pluggable tools. Zero npm dependencies. Decentralised by design — every project gets its own listener, its own prompt, its own tool set, its own lifecycle. The whole install lives in **one directory (`.nanogent/`)** you can commit, copy between projects, or delete wholesale.

By default, nanogent ships with one tool: **`claude`**, which delegates coding tasks to [Claude Code](https://docs.claude.com/claude-code). You can add more tools (`rag`, `search`, `opencode`, etc.) by dropping a folder into `.nanogent/tools/` — the core runtime never needs to change.

```
┌─────────┐     ┌────────────────────────────────────────┐      ┌─────────────┐
│         │     │  nanogent.mjs (chat agent)             │      │   claude    │
│Telegram │◀───▶│  ┌──────────────────────────────────┐  │─────▶│  (one tool, │
│         │     │  │ loop: poll → turn → tool dispatch │  │ async│  not core)  │
└─────────┘     │  └──────────────────────────────────┘  │      └─────────────┘
                │         │          │          │        │      ┌─────────────┐
                │         ▼          ▼          ▼        │─────▶│   rag.mjs   │
                │       skip       learn    check_job    │      │  (future)   │
                │      (core)      (core)    (core)      │      └─────────────┘
                └────────────────────────────────────────┘      ┌─────────────┐
                         lives inside your project               │  codex.mjs  │
                                                                 │   (future)  │
                                                                 └─────────────┘
```

## Two layers, one file per tool

- **Chat agent (core, `nanogent.mjs`)** — runs a small Anthropic API loop (Claude Haiku by default) to decide whether to answer the client directly, `skip` side chatter, `learn` a preference, `check_job_status`, `cancel_job`, or delegate to a project-specific tool.
- **Tools (`.nanogent/tools/<name>/`)** — one folder per capability, each with a required `index.mjs` that default-exports `{ name, description, input_schema, execute(input, ctx) }`. Long-running tools return `{ async: true, jobId }` immediately and keep the chat agent responsive while they run. When a job finishes, a synthetic `[SYSTEM]` message is injected into the conversation and the chat agent decides how to tell the client.

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
| Deployable on a VPS / Raspberry Pi / headless box? | Awkward | Yes — `pm2 start nanogent.mjs` or `docker compose up -d` |
| Client-facing? | Developer-only | Yes — chat agent handles small talk, skipping, clarification |
| Extensibility | MCP servers | Drop-in folder tools per project |
| Moving parts | MCP server + pairing codes + session | One `.mjs` runtime + per-tool folders + `.env` |
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
The runtime is a single file (`.nanogent/nanogent.mjs`) with zero npm dependencies. It uses raw `fetch` against the Anthropic and Telegram APIs instead of pulling in the official SDKs. You should be able to `cat` it and understand the whole thing in one sitting — every tool dispatch, every queue, every piece of state. If a proposed change would make the file materially harder to read in exchange for a minor feature, the change loses.

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

- Node.js ≥ 18 (uses global `fetch`)
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com) (for the chat agent itself)
- If you keep the default `claude` tool: [`claude` CLI](https://docs.claude.com/claude-code) installed and authenticated (`claude --version` should work)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram chat ID — message [@userinfobot](https://t.me/userinfobot) to get it

## Install & run

One command drops everything into a single `.nanogent/` directory — your project root stays untouched. Node is the default; docker is a config flip, not a separate install.

```bash
cd your-project
npx nanogent init                        # drops .nanogent/ with all plugin folders
cp .nanogent/.env.example .nanogent/.env  # fill in TELEGRAM_BOT_TOKEN + ANTHROPIC_API_KEY
$EDITOR .nanogent/contacts.json           # add yourself as operator with your Telegram chatId
$EDITOR .nanogent/prompt.md               # tailor the system prompt for this project / client
nanogent start                            # reads .nanogent/config.json to choose node or docker mode
```

What lands in your project:

```
your-project/
  .nanogent/
    nanogent.mjs              ← core runtime (readable, auditable, committed)
    config.json               ← non-secret settings (projectName, docker, chatModel) — committed
    contacts.json             ← access control + identity map — committed
    prompt.md                 ← system prompt — committed
    Dockerfile                ← dropped always; inert unless config.docker=true
    docker-compose.yml        ← same
    .env.example              ← template for secrets — committed
    .env                      ← actual secrets — gitignored via .nanogent/.gitignore
    .gitignore                ← hides .env and state/
    state/                    ← runtime state (history, jobs, learnings) — gitignored
    tools/
      claude/                 ← default coding tool
        index.mjs
        README.md
    channels/
      telegram/               ← default channel plugin
        index.mjs
        README.md
    providers/
      anthropic/              ← default AI provider plugin
        index.mjs
        README.md
```

**Your project root is untouched** — nothing nanogent-related lives outside `.nanogent/`. Teams commit `.nanogent/` as a unit to share prompt, tools, and config; runtime state stays local.

### Node vs Docker

`nanogent start` picks the mode automatically based on `.nanogent/config.json`:

```json
{ "docker": false }     // run as a node process in the current shell
{ "docker": true }      // run in a container via docker compose
```

Override at the command line without editing config:

```bash
nanogent start --node      # force node mode
nanogent start --docker    # force docker mode
```

**Background supervision** (node mode):

```bash
nohup node .nanogent/nanogent.mjs > nanogent.log 2>&1 &    # quick & dirty
pm2 start .nanogent/nanogent.mjs --name nanogent           # or pm2
```

**Docker specifics:** the container binds the project root (`..` from `.nanogent/`'s perspective) as `/workspace`, and mounts `~/.claude` + `~/.claude.json` so the `claude` tool can reuse your host auth. Recommended for VPS / VM / Pi setups where you'd rather not run `--dangerously-skip-permissions` directly on the host.

**Auth on a headless VM:** SSH in, run `claude` once on the host, complete the login flow, and `~/.claude` will exist on the VM. The container reuses it on every boot — no token plumbing required.

Detached docker: `nanogent start --docker` ... then Ctrl+C. Or `cd .nanogent && docker compose up -d --build`. Follow logs with `docker compose logs -f`.

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
  "docker": false,
  "chatModel": "claude-haiku-4-5",
  "maxHistory": 80,
  "maxTokens": 1024
}
```

- `projectName` — identifier for this install; surfaces in logs, system prompt, and tool context
- `docker` — whether `nanogent start` uses compose or plain node (overridable via `--docker`/`--node`)
- `chatModel` — Anthropic model for the chat-agent routing layer. Default `claude-haiku-4-5` (cheap + fast)
- `maxHistory` — turns kept in history before boundary-aware rotation
- `maxTokens` — max output tokens per chat-agent turn

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
3. Set them as real environment variables (systemd unit, pm2 ecosystem, docker `environment:`) — the runtime falls back to `process.env` for every key, so no `.env` file is strictly required

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
- **`nanogent.mjs` is still one file you can audit** — ~30 KB, zero npm deps
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

A tool is a **folder** in `.nanogent/tools/` with one required file: `index.mjs`. Everything else in the folder — helpers, assets, schemas, README, tests — is the tool's own business.

```
.nanogent/tools/
  claude/
    index.mjs        ← REQUIRED. Default-exports the tool object.
    README.md        ← recommended — setup notes, API keys, example invocations.
  rag/               ← example of a folder-shaped tool that outgrew one file
    index.mjs
    README.md
    chunker.mjs      ← helpers the tool imports via normal relative imports
    schemas/
      answer.json
```

Minimum viable tool — `rag/index.mjs`:

```js
export default {
  name: 'rag',
  description: 'Answer a question by searching the project\'s knowledge base.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The question to answer.' },
    },
    required: ['query'],
  },
  async execute({ query }, ctx) {
    // Sync fast tool — just return the result.
    const answer = await searchKnowledgeBase(query);
    return { content: answer };
  },
};
```

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

Tools are discovered at startup by scanning `.nanogent/tools/` for directories. Each directory must contain an `index.mjs` that default-exports `{ name, description, input_schema, execute }` — if the file is missing or the shape is wrong, the tool is skipped with a log line. Directories starting with `_` are ignored (scratch / wip space). No manifest, no config file, no naming rules beyond `index.mjs` — drop a folder, restart, it's loaded.

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

## How it works

1. **Long-poll Telegram.** No webhook, no inbound ports.
2. **Slash commands** (`/status`, `/cancel`, `/clear`) run directly against the runtime's state — no LLM call.
3. **Normal messages** get enqueued as "turn triggers". A worker processes triggers one at a time per project (so conversation stays coherent), running a **chat-agent turn** against the Anthropic API.
4. **Each turn** builds the system prompt from `.nanogent-prompt.md` + learnings + current job state, passes the full history + the union of core tools + plugin tool schemas, and runs the tool-use loop until the model returns `stop_reason: end_turn`.
5. **Tool calls** during a turn are dispatched to the right tool's `execute`. Sync tools return inline. Async tools register a background job and return immediately — the turn ends quickly with a "working on it" message.
6. **Background jobs** resolve on their own timeline. On completion, the runtime enqueues a synthetic `[SYSTEM]` trigger (`Tool 'claude' (job abc, "make header darker") completed after 47s: ...`), and the worker runs a fresh chat-agent turn on it. The model sees the result and decides what to say to the client — usually sends a completion message, which Telegram pushes as a notification.
7. **Chat history** persists to `.nanogent/state/history.jsonl`, loaded on startup. Learnings persist to `.nanogent/state/learnings.md`. Both survive restarts, redeployments, and container rebuilds.

The chat agent itself is ~20 LOC of Anthropic API loop + a small tool dispatch table. Everything else is plumbing (Telegram, history, learnings, job registry, slash commands).

## Stopping & removing

```bash
# stop (node)
Ctrl+C                # or: pm2 stop nanogent / kill <pid>

# stop (docker)
cd .nanogent && docker compose down

# fully remove from a project
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
Yes. Delete `.nanogent/tools/claude.mjs` and nanogent becomes a pure chat bot with whatever other tools you have (or none at all — `skip` + `learn` + `check_job_status` + `cancel_job` still work for small-talk-only setups).

**Can I have multiple coding tools at once (e.g. `claude` + `opencode`)?**
Yes. Both tool files live side-by-side in `.nanogent/tools/`. Tell the chat agent in `.nanogent-prompt.md` which tool to prefer for which kinds of tasks (e.g. *"use `claude` for TypeScript, `opencode` for Python data work"*). Tools don't know about each other; the chat agent routes.

**Does the chat agent remember things across restarts?**
Yes. Chat history persists to `.nanogent/state/history.jsonl`, and learnings persist to `.nanogent/state/learnings.md`. If the process (or container) restarts, the conversation continues where it left off.

**What if my message lands while a background job is running?**
The chat agent handles it. It can answer directly, call `check_job_status`, call `cancel_job` to switch directions, or refuse to start a second job of the same kind. The runtime only enforces one background job at a time — how to handle a busy state is the chat agent's decision.

**Does it support WhatsApp / Discord / Slack?**
No. Telegram only, by design. If you need Discord or iMessage, [Claude Code Channels](https://code.claude.com/docs/en/channels) already covers those. Fork and swap the transport if you want another channel here.

**Can I run multiple projects at once?**
Yes — each project runs its own `nanogent.mjs`. Give each one its own bot token (or at least its own allowlisted chat) so messages don't cross wires.

## License

[MIT](./LICENSE) © Khur Boon Kgim
