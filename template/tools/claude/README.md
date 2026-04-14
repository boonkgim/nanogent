# claude tool

Default nanogent tool. Wraps `claude -p` and delegates any coding task to
Claude Code, running as an asynchronous background job.

## What it does

When the chat agent calls this tool with `{ prompt, title }`, it:

1. Spawns `claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions` in the project root (`ctx.projectDir`), passing `--continue` after the first run so Claude Code resumes its session.
2. Streams the assistant output into a single Telegram message that it edits in place (throttled to Telegram's edit rate limit).
3. Returns immediately as an async tool (`{ async: true, jobId, content }`) so the chat agent stays responsive.
4. When `claude` exits, resolves its registered promise — the runtime then injects a `[SYSTEM]` message into chat history so the chat agent can tell the client the job is done.

## Setup

- The `claude` CLI must be installed and authenticated on the host (or inside the container, if you're running with `docker: true` in `.nanogent/config.json`).
  - `npm install -g @anthropic-ai/claude-code`
  - `claude` (complete the login flow once — writes `~/.claude`)
- On headless VMs, run `claude` once over SSH so `~/.claude` exists on the VM; the container reuses it via the compose bind-mount.
- No additional API keys beyond your regular Claude Code auth — this tool uses the same credentials `claude --version` would use.

## Safety

This tool passes `--dangerously-skip-permissions`, so `claude` will run shell commands and edit files without confirmation. Anyone allowed in `TELEGRAM_ALLOWED_CHAT_IDS` can therefore trigger arbitrary work in the project directory via the chat agent. Only enable this tool in projects you trust with chats you trust, or run inside the docker sandbox where the container only sees the bind-mounted project root.

## Removing it

```bash
rm -rf .nanogent/tools/claude
```

Restart nanogent and the tool is gone. The chat agent will continue to work (with whatever other tools remain, or none at all — small talk, learnings, and status still work).

## Customising

Open `.nanogent/tools/claude/index.mjs` — it's self-contained (imports only from node stdlib and talks to the injected `ctx`). Edit it in place. Common tweaks:

- **Different `claude` flags** — e.g. remove `--dangerously-skip-permissions` if you want permission prompts on the host (only useful when running without docker).
- **Different output format** — the current parser is tuned for `stream-json`; if you prefer the plain streaming output, change the args and drop the `stream-json` parser.
- **Session scope** — the session marker file at `.nanogent/state/claude-session.marker` gates `--continue`. Delete it to force a fresh session on the next run (same as the `/clear` slash command on nanogent's side).
