# nanogent

A **per-project chat agent** reachable via Telegram, with pluggable tools. Zero npm dependencies. Decentralised by design — every project gets its own listener, its own prompt, its own tool set, its own lifecycle.

By default, nanogent ships with one tool: **`claude`**, which delegates coding tasks to [Claude Code](https://docs.claude.com/claude-code). You can add more tools (`rag`, `search`, `opencode`, etc.) by dropping `.mjs` files into `.nanogent/tools/` — the core runtime never needs to change.

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
- **Tools (`.nanogent/tools/*.mjs`)** — one file per capability. Each tool exports `{ name, description, input_schema, execute(input, ctx) }`. Long-running tools return `{ async: true, jobId }` immediately and keep the chat agent responsive while they run. When a job finishes, a synthetic `[SYSTEM]` message is injected into the conversation and the chat agent decides how to tell the client.

This is the **open/closed** split: the core is closed for modification; tools are open for extension. Adding a new tool is dropping one file. The core knows nothing about `claude`, `opencode`, `rag`, or anything else specific.

## nanogent vs. Claude Code Channels

Anthropic's [Claude Code Channels](https://code.claude.com/docs/en/channels) pushes messages into a **running** Claude Code session. It's the right tool when you're at your desk with Claude Code open. **nanogent covers the case it doesn't** — when nobody's at the keyboard, when the other end is a client rather than a developer, and when you want a conversational layer above the raw coding agent.

|  | Claude Code Channels | nanogent |
|---|---|---|
| Model | MCP plugin → running Claude Code session | Standalone chat agent → tools (one of which may be `claude`) |
| Requires a live Claude Code session? | **Yes** | No — spawns `claude -p` on demand via the `claude` tool |
| Permission prompts | **Pause remotely** | Bypassed via `--dangerously-skip-permissions` (allowlist gated) |
| Deployable on a VPS / Raspberry Pi / headless box? | Awkward | Yes — `pm2 start nanogent.mjs` or `docker compose up -d` |
| Client-facing? | Developer-only | Yes — chat agent handles small talk, skipping, clarification |
| Extensibility | MCP servers | Drop-in `.mjs` tool files per project |
| Moving parts | MCP server + pairing codes + session | One `.mjs` runtime + per-tool files + `.env` |
| Supported channels | Telegram, Discord, iMessage | Telegram only, by design |

**Use Channels** when you're coding interactively and want a chat-flavored remote for your live session.
**Use nanogent** when you want a per-project assistant you can hand to a client, run on a VPS, or compose with custom tools.

## Why decentralised?

Most Telegram→agent tools run a **single central process** with a config mapping chat IDs → projects. That's powerful but heavy: one process owns every project, and tearing it down is a global operation.

**nanogent inverts that.** Each project gets its own listener, its own Telegram bot (or just its own allowlisted chat IDs), its own system prompt, its own tool set, and its own lifecycle. Start it when you're working on the project, stop it when you're not, remove it when you're done. The project owns the bridge.

## Requirements

- Node.js ≥ 18 (uses global `fetch`)
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com) (for the chat agent itself)
- If you keep the default `claude` tool: [`claude` CLI](https://docs.claude.com/claude-code) installed and authenticated (`claude --version` should work)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram chat ID — message [@userinfobot](https://t.me/userinfobot) to get it

## Install & run

Two launchers, same runtime. Both work the same from the user's side; pick whichever fits your box.

### Option A — Node (default, zero npm deps)

```bash
cd your-project
npx nanogent init              # drops nanogent.mjs, .env.example, .nanogent-prompt.md, .nanogent/tools/claude.mjs
cp .env.example .env           # fill in TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS, ANTHROPIC_API_KEY
$EDITOR .nanogent-prompt.md    # customise the system prompt for this project / client
nanogent start                 # or: node nanogent.mjs
```

To keep it running in the background, use any process supervisor:

```bash
nohup node nanogent.mjs > nanogent.log 2>&1 &   # quick & dirty
pm2 start nanogent.mjs --name nanogent          # or pm2
```

### Option B — Docker (sandboxed, Node 24)

Same flow, but both the chat agent and the `claude` tool run inside a container with your project bind-mounted at `/workspace`. Recommended for VPS / VM / Pi setups where you'd rather not run `--dangerously-skip-permissions` directly on the host.

```bash
cd your-project
npx nanogent init --docker     # drops everything above + Dockerfile + docker-compose.yml
cp .env.example .env           # fill in all three keys (Telegram + Anthropic)
$EDITOR .nanogent-prompt.md
claude                         # one-time: log in on the host so ~/.claude exists
nanogent start --docker        # or: docker compose up --build
```

The compose file bind-mounts:

- `.` → `/workspace` — the project the tools work in
- `~/.claude` → `/root/.claude` — your Claude Code auth (read from the host)
- `~/.claude.json` → `/root/.claude.json` — per-user config

**Auth on a headless VM:** SSH in, run `claude` once, complete the login flow, and `~/.claude` will exist on the VM. The container reuses it on every boot — no token plumbing required.

To run detached: `docker compose up -d --build`. To follow logs: `docker compose logs -f`.

## Configuration

A `.env` file in the project root:

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
ANTHROPIC_API_KEY=sk-ant-...
# NANOGENT_CHAT_MODEL=claude-haiku-4-5   # optional, default is haiku
# NANOGENT_MAX_TOKENS=1024                # optional
# NANOGENT_MAX_HISTORY=80                 # optional — turns kept in history before rotation
```

- `TELEGRAM_BOT_TOKEN` — required
- `TELEGRAM_ALLOWED_CHAT_IDS` — comma-separated chat IDs. **Leave empty to allow anyone** (not recommended)
- `ANTHROPIC_API_KEY` — required, for the chat agent itself
- `NANOGENT_CHAT_MODEL` — optional, defaults to `claude-haiku-4-5`

The **system prompt** lives in `.nanogent-prompt.md` — edit it to describe the project, the client, the tone, and anything specific to this engagement. It's loaded verbatim on every turn.

## How clients talk to it

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

A tool is a single `.mjs` file in `.nanogent/tools/` that default-exports this shape:

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

What `ctx` provides:

| | |
|---|---|
| `ctx.projectDir` | The project root (cwd) |
| `ctx.chatId` | Telegram chat the request came from |
| `ctx.sendMessage(text)` | Post a new Telegram message |
| `ctx.editMessage(msgId, text)` | Edit a message the tool previously sent |
| `ctx.newJobId()` | Generate a new job id |
| `ctx.backgroundJob(id, promise, cancelFn, meta)` | Register a long-running job |
| `ctx.busy()` | Returns `null` or the currently-running job descriptor |
| `ctx.log(...)` | Scoped logger |

Tools are discovered at startup by globbing `.nanogent/tools/*.mjs`. Files starting with `_` are ignored (useful for helpers). No manifest, no config — drop a file, restart, it's loaded.

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
docker compose down

# fully remove from a project
rm -rf nanogent.mjs .nanogent .nanogent-prompt.md .env
rm -f Dockerfile docker-compose.yml   # if you used --docker
```

Uninstalling is deleting files. That's still the whole point.

## Security notes

- **`--dangerously-skip-permissions`** is passed to the `claude` tool so it can run without interactive prompts. That means anyone in your `TELEGRAM_ALLOWED_CHAT_IDS` list can trigger arbitrary shell work in the project directory via the chat agent. **Only use it in projects you trust with chats you trust.** For a hard sandbox, use the Docker option — the container can only see the bind-mounted `/workspace` and the mounted Claude auth.
- Always set `TELEGRAM_ALLOWED_CHAT_IDS`. Leaving it empty exposes the bot to anyone who discovers its username.
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
