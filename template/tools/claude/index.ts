// claude tool — wraps `claude -p` as an async background job.
// Self-contained: only imports from node stdlib, talks to the injected `ctx`.
// Streams assistant text + tool markers into a single Telegram message that it
// edits in place. When the child exits, resolves its registered promise so the
// runtime can inject the completion as a [SYSTEM] message for the chat agent.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ToolCtx, ToolPlugin, ToolResult } from '../../types.d.ts';

const MAX_LEN = 3800;
const EDIT_MS = 1200;

const plugin: ToolPlugin = {
  name: 'claude',
  description:
    'Send a coding task to Claude Code (runs `claude -p` in the project directory). '
    + 'Use this for any code changes, file reads/writes, refactors, debugging, code inspection, '
    + 'or any task that requires reading or writing project files. '
    + 'The task runs asynchronously: this tool returns immediately with a job ID, and you will '
    + 'receive a [SYSTEM] message when the job completes. '
    + 'IMPORTANT: Claude Code has no memory of previous conversations — your prompt must be '
    + 'fully self-contained. Include any relevant context from this conversation (what was '
    + 'previously changed, which files were touched, what the user wants now).',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Clean, self-contained coding instruction. Rephrase the user\'s request into a clear '
          + 'task for a coding agent that has no prior context.',
      },
      title: {
        type: 'string',
        description: 'Short title (3–6 words) describing this task, used in status messages.',
      },
    },
    required: ['prompt', 'title'],
  },

  async execute(input: { prompt?: string; title?: string }, ctx: ToolCtx): Promise<ToolResult> {
    const { prompt, title } = input;
    const busy = ctx.busy();
    if (busy) {
      return {
        content:
          `error: another job is already running ('${busy.title}', id=${busy.jobId}). `
          + `Ask the user whether to cancel it (cancel_job) or wait for it to finish.`,
      };
    }
    if (!prompt || !title) {
      return { content: 'error: both prompt and title are required' };
    }

    const jobId = ctx.newJobId();
    // Tool-scoped state: the session marker lives inside this tool's own folder,
    // not in the core `.nanogent/state/` directory. Core's gitignore does not
    // reach here — the tool ships its own .gitignore to hide `state/`.
    const stateDir = join(ctx.toolDir, 'state');
    const sessionMarker = join(stateDir, 'session.marker');
    const hasSession = existsSync(sessionMarker);
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      ...(hasSession ? ['--continue'] : []),
    ];

    // Create the status message we'll edit in place.
    const statusHandle = await ctx.sendMessage(`🔧 ${title}\n⏳ starting…`);

    let acc = '';
    let finalResult = '';
    let lastEdit = 0;
    let pendingTimer: NodeJS.Timeout | null = null;

    const render = (): string => {
      const body = (finalResult || acc || '…').slice(-MAX_LEN);
      return `🔧 ${title}\n\n${body}`;
    };

    const flush = (): void => {
      if (!statusHandle) return;
      const now = Date.now();
      const wait = EDIT_MS - (now - lastEdit);
      if (wait > 0) {
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(flush, wait);
        return;
      }
      lastEdit = now;
      void ctx.editMessage(statusHandle, render());
    };

    const child = spawn('claude', args, { cwd: ctx.projectDir, env: process.env });
    let buffer = '';
    let cancelled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed) as {
            type?: string;
            message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> };
            result?: string;
          };
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const b of ev.message.content) {
              if (b.type === 'text' && b.text) {
                acc += b.text;
              } else if (b.type === 'tool_use') {
                acc += `\n🔧 ${b.name ?? '?'}(${Object.keys(b.input || {}).join(', ')})\n`;
              }
            }
          } else if (ev.type === 'result') {
            finalResult = ev.result || acc;
          }
        } catch {
          // not JSON — ignore
        }
      }
      flush();
    });

    child.stderr.on('data', (d: Buffer) => { process.stderr.write(d); });

    // Promise that resolves (or rejects) when claude exits. The runtime awaits
    // this and will inject a [SYSTEM] message with whatever we return.
    const donePromise = new Promise<string>((resolveDone, rejectDone) => {
      child.on('close', code => {
        if (pendingTimer) clearTimeout(pendingTimer);
        try {
          if (!hasSession) {
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(
              sessionMarker,
              JSON.stringify({ started: new Date().toISOString() }) + '\n',
            );
          }
        } catch { /* ignore */ }

        const body = (finalResult || acc).trim() || '(no output)';
        const prefix = cancelled ? '🛑 cancelled' : code === 0 ? '✅ done' : `⚠️ exit ${code}`;
        if (statusHandle) {
          void ctx.editMessage(statusHandle, `${prefix}: ${title}\n\n${body.slice(-MAX_LEN)}`);
        }

        if (cancelled) {
          resolveDone(`Job was cancelled. Partial output (if any):\n${body.slice(-2000)}`);
          return;
        }
        if (code !== 0) {
          resolveDone(`Claude exited with code ${code}. Output:\n${body.slice(-2000)}`);
          return;
        }
        resolveDone(body.slice(-2000));
      });
      child.on('error', err => { rejectDone(err); });
    });

    const cancel = (): void => {
      cancelled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    };

    ctx.backgroundJob(jobId, donePromise, cancel, { toolName: 'claude', title });

    return {
      async: true,
      jobId,
      content:
        `Started job '${title}' (id=${jobId}) using the claude tool. Tell the user you're `
        + `working on it. You will receive a [SYSTEM] message when it completes.`,
    };
  },
};

export default plugin;
