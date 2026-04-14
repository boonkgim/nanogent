# nanogent

A tiny, zero-dependency bridge that runs [Claude Code](https://docs.claude.com/claude-code) **unattended** from Telegram — **per project**, not per machine.

Drop a single file into your project, point it at a Telegram bot, and message it to run `claude -p` headlessly in that folder. No running session required, no interactive permission prompts, no central router, no Docker. When the project is done, delete the file.

```
┌─────────┐    messages    ┌──────────────┐   fresh headless    ┌──────────────┐
│ Telegram│ ◀────────────▶ │ nanogent.mjs │ ──────────────────▶ │  claude -p   │
└─────────┘                │  (this repo) │   per message       │  (spawned)   │
                           └──────────────┘                     └──────────────┘
                             lives inside
                             your project
```

## nanogent vs. Claude Code Channels

In March 2026 Anthropic shipped [Claude Code Channels](https://code.claude.com/docs/en/channels) — an [official Telegram plugin](https://claude.com/plugins/telegram) that pushes messages into a **running** Claude Code session. It's the right tool when you're at your desk with Claude Code open. **nanogent covers the case it doesn't.**

|  | Claude Code Channels | nanogent |
|---|---|---|
| Model | MCP plugin → running session | Standalone script → fresh headless run per message |
| Requires a live Claude Code session? | **Yes** — close the terminal and the channel goes offline | No — spawns `claude -p` on demand |
| Permission prompts | **Pause remotely** — you must approve at the terminal | Bypassed via `--dangerously-skip-permissions` (allowlist gated) |
| Deployable on a VPS / Raspberry Pi / headless box? | Awkward — you'd have to keep Claude Code open | Yes — `pm2 start nanogent.mjs` and walk away |
| Queue / `/cancel` / `/status` mid-job | Conversational (in-session) | Built-in primitives |
| Moving parts | MCP server + pairing codes + session | One `.mjs` file + `.env` |
| Supported channels | Telegram, Discord, iMessage | Telegram only, by design |

**Use Channels** when you're coding interactively and want a chat-flavored remote for your live session.
**Use nanogent** when nobody's at the keyboard — remote ops, agent-on-a-box, batch workflows, or any project you want to poke from your phone while the machine runs headless in a closet.

## Why decentralized?

Most Telegram→agent tools (OpenClaw, client-agent-router, and arguably Channels itself) run a single central process with a config mapping chat IDs → projects. That's powerful but heavy: one process owns every project, and tearing it down is a global operation.

**nanogent** inverts that. Each project gets its own small listener, its own Telegram bot (or just its own allowlisted chat IDs), and its own lifecycle. Start it when you're working on the project, stop it when you're not, remove it when you're done. The project owns the bridge.

## Requirements

- Node.js ≥ 18 (uses global `fetch` and top-level `await`)
- [`claude` CLI](https://docs.claude.com/claude-code) installed and authenticated (`claude --version` should work)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram chat ID — message [@userinfobot](https://t.me/userinfobot) to get it

## Install & run

```bash
cd your-project
npx nanogent init              # drops nanogent.mjs + .env.example
cp .env.example .env           # fill in TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS
nanogent start                 # or: node nanogent.mjs
```

That's it. Message your bot from Telegram and it will run `claude -p <your message>` inside the current working directory.

To keep it running in the background, use any process supervisor:

```bash
nohup node nanogent.mjs > nanogent.log 2>&1 &   # quick & dirty
pm2 start nanogent.mjs --name nanogent          # or pm2
```

## Configuration

A `.env` file in the project root:

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
```

- `TELEGRAM_BOT_TOKEN` — required. Get it from [@BotFather](https://t.me/BotFather).
- `TELEGRAM_ALLOWED_CHAT_IDS` — comma-separated list of chat IDs allowed to talk to this bot. **Leave empty to allow anyone** (not recommended).

## In-chat commands

Once nanogent is running, send these to the bot:

| Command | Description |
|---|---|
| *(any text)* | Run as a Claude Code prompt in the project folder |
| `/status` | Show the currently running job and queue depth |
| `/cancel` | SIGTERM the running job |
| `/queue` | List running + queued prompts |
| `/help` | Show command list |

While a job is running, new prompts are automatically **queued** and run FIFO. The chat agent never blocks — `/status` and `/cancel` respond instantly even mid-job.

## How it works

1. Long-polls Telegram's `getUpdates` API — no webhook, no inbound ports.
2. On a prompt, spawns `claude -p "<prompt>" --output-format stream-json --verbose --dangerously-skip-permissions [--continue]` in the project directory.
3. Parses the stream-json events as they arrive and edits a single Telegram message with the accumulated assistant text + `🔧 tool_name(...)` markers (throttled to ~1.2s per edit to respect Telegram's rate limits).
4. On first run, creates `.nanogent.json` as a marker. Subsequent runs pass `--continue` so Claude Code resumes the same session.

Session state lives in Claude Code's own per-directory history — nanogent stores nothing but the first-run marker and your `.env`.

## Stopping & removing

```bash
# stop
Ctrl+C                # or: pm2 stop nanogent / kill <pid>

# fully remove from a project
rm nanogent.mjs .nanogent.json .env
```

Uninstalling is deleting files. That's the whole point.

## Security notes

- **`--dangerously-skip-permissions`** is passed to Claude Code so it can run tools without interactive prompts. This means anyone on your `TELEGRAM_ALLOWED_CHAT_IDS` list can run arbitrary shell commands in the project directory. **Only use it in projects you trust with chats you trust.**
- Always set `TELEGRAM_ALLOWED_CHAT_IDS`. Leaving it empty exposes the bot to anyone who discovers its username.
- Use a **separate bot token per project** if you want hard isolation. Telegram bot tokens are free and unlimited.
- Treat `.env` like any other secret file — add it to `.gitignore`.

## FAQ

**Does it support WhatsApp / Discord / Slack?**  
No. Telegram only, by design — keeping it tiny is the point. If you need Discord or iMessage, [Claude Code Channels](https://code.claude.com/docs/en/channels) already covers those. Fork and swap the transport if you want another channel here.

**Why would I use this instead of Claude Code Channels?**  
Channels pushes messages into a running Claude Code session — great when you're at your desk. nanogent spawns a fresh headless `claude -p` per message and runs without interactive permission prompts, so it works on a VPS, a Raspberry Pi, or any headless box where nobody's sitting at the terminal. See the [comparison table](#nanogent-vs-claude-code-channels) above.

**Can I run multiple projects at once?**  
Yes — each project runs its own `nanogent.mjs` process. Give each one its own bot token (or at least its own allowlisted chat) so messages don't cross wires.

**Can the bot reply while Claude Code is working?**  
Yes. The poll loop never awaits the Claude Code child. `/status`, `/cancel`, `/queue`, and even queueing new prompts all work mid-job.

**What if Claude Code's `stream-json` format changes?**  
The parser ignores unknown events. At worst you lose streaming updates — the final `result` event (or non-streaming fallback) still renders.

## License

[MIT](./LICENSE) © Khur Boon Kgim
