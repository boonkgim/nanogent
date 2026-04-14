// tools/schedule — agent-facing proactive scheduling, self-contained.
//
// This plugin owns BOTH the agent-facing tool surface (create/list/cancel
// via `execute()`) AND the background tick loop that fires due schedules
// (via the lifecycle `start()` hook). State lives under the plugin's own
// folder — `pluginDir/state/schedules.json` for definitions and
// `pluginDir/state/log.jsonl` for the append-only execution log. Core
// knows nothing about scheduling; it only hands this tool `fireSystemTurn`
// and a plugin directory.
//
// Schedule string formats:
//   once@<ISO-UTC>     one-shot, e.g. "once@2026-04-15T18:00:00Z"
//   daily@HH:MM        every day at HH:MM UTC, e.g. "daily@08:00"
//   every@<seconds>    interval from creation, e.g. "every@3600" (hourly)
//
// See DESIGN.md DR-010 (proactive triggers) and DR-014 (minimal coupling).

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ToolPlugin, ToolStartCtx } from '../../types.d.ts';

// ---------------------------------------------------------------------------
// Internal types — plugin-private, not exported to the shared contract.
// ---------------------------------------------------------------------------

interface Schedule {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  channel: string;
  chatId: string;
  contactId: string;
  createdAt: string;
}

interface ScheduleExecution {
  firedAt: string;
  scheduleId: string;
  jobId: string;
  status: 'claimed' | 'completed' | 'failed';
  error?: string;
}

// ---------------------------------------------------------------------------
// Module state — wired up at start() time.
// ---------------------------------------------------------------------------

let schedulesPath = '';
let logPath = '';
let log: (...args: unknown[]) => void = () => {};
let fireSystemTurn: ToolStartCtx['fireSystemTurn'] = () => {};
let schedulesCache: Schedule[] = [];
let tickTimer: NodeJS.Timeout | null = null;

const TICK_MS = 60_000;

// ---------------------------------------------------------------------------
// Disk I/O
// ---------------------------------------------------------------------------

function loadSchedules(): Schedule[] {
  if (!existsSync(schedulesPath)) return [];
  try {
    const raw = readFileSync(schedulesPath, 'utf8');
    const parsed = JSON.parse(raw) as { schedules?: Schedule[] };
    return parsed.schedules || [];
  } catch (e) {
    log('schedules.json load error', (e as Error)?.message || e);
    return [];
  }
}

function saveSchedules(): void {
  writeFileSync(schedulesPath, JSON.stringify({ schedules: schedulesCache }, null, 2) + '\n');
}

function appendLog(entry: ScheduleExecution): void {
  appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function readLog(): ScheduleExecution[] {
  if (!existsSync(logPath)) return [];
  const out: ScheduleExecution[] = [];
  try {
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { out.push(JSON.parse(l) as ScheduleExecution); } catch { /* skip malformed */ }
    }
  } catch (e) {
    log('log.jsonl read error', (e as Error)?.message || e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schedule string parsing and next-fire computation
// ---------------------------------------------------------------------------

function computeNextFire(schedule: Schedule, lastFiredAt: Date | null): Date | null {
  const s = (schedule.schedule || '').trim();

  if (s.startsWith('once@')) {
    if (lastFiredAt) return null;
    const target = new Date(s.slice(5));
    if (isNaN(target.getTime())) return null;
    return target;
  }

  if (s.startsWith('every@')) {
    const seconds = parseInt(s.slice(6), 10);
    if (isNaN(seconds) || seconds < 1) return null;
    const anchor = lastFiredAt || new Date(schedule.createdAt);
    return new Date(anchor.getTime() + seconds * 1000);
  }

  if (s.startsWith('daily@')) {
    const m = s.slice(6).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hour = parseInt(m[1]!, 10);
    const minute = parseInt(m[2]!, 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const anchor = lastFiredAt || new Date(schedule.createdAt);
    const next = new Date(anchor);
    next.setUTCHours(hour, minute, 0, 0);
    if (next <= anchor) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Execution log indexing
// ---------------------------------------------------------------------------

interface LogIndex {
  lastSuccess: Map<string, Date>;
  inFlight: Set<string>;
  byJob: Map<string, ScheduleExecution[]>;
}

function indexLog(entries: ScheduleExecution[]): LogIndex {
  const byJob = new Map<string, ScheduleExecution[]>();
  for (const e of entries) {
    if (!byJob.has(e.jobId)) byJob.set(e.jobId, []);
    byJob.get(e.jobId)!.push(e);
  }

  const lastSuccess = new Map<string, Date>();
  const inFlight = new Set<string>();
  for (const js of byJob.values()) {
    const last = js[js.length - 1]!;
    if (last.status === 'claimed') {
      inFlight.add(last.scheduleId);
      continue;
    }
    if (last.status === 'completed') {
      const firedAt = new Date(js[0]!.firedAt);
      const prev = lastSuccess.get(last.scheduleId);
      if (!prev || firedAt > prev) lastSuccess.set(last.scheduleId, firedAt);
    }
  }

  return { lastSuccess, inFlight, byJob };
}

// If a previous process crashed between `claimed` and `completed`/`failed`,
// the scheduleId stays pinned in `inFlight` forever. On boot, fail-forward
// any orphan claims so the schedule becomes eligible again on its next tick.
function recoverOrphanClaims(): void {
  const entries = readLog();
  const { byJob } = indexLog(entries);
  const now = new Date().toISOString();
  let recovered = 0;
  for (const [jobId, js] of byJob) {
    const last = js[js.length - 1]!;
    if (last.status === 'claimed') {
      appendLog({
        firedAt: now,
        scheduleId: last.scheduleId,
        jobId,
        status: 'failed',
        error: 'orphan-crash-recovery',
      });
      recovered++;
    }
  }
  if (recovered > 0) log(`recovered ${recovered} orphan claim(s) from previous run`);
}

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  try {
    const { lastSuccess, inFlight } = indexLog(readLog());
    const now = new Date();
    let fired = 0;

    for (const schedule of schedulesCache) {
      if (fired >= 10) break;
      if (inFlight.has(schedule.id)) continue;
      const lastFired = lastSuccess.get(schedule.id) || null;
      const nextFire = computeNextFire(schedule, lastFired);
      if (!nextFire) continue;
      if (nextFire > now) continue;

      const jobId = 'job_' + randomUUID().slice(0, 8);
      const firedAt = nextFire.toISOString();
      appendLog({ firedAt, scheduleId: schedule.id, jobId, status: 'claimed' });

      try {
        fireSystemTurn({
          channel:   schedule.channel,
          chatId:    schedule.chatId,
          contactId: schedule.contactId,
          text:      `[SCHEDULED "${schedule.name}"] ${schedule.prompt}`,
        });
        appendLog({ firedAt, scheduleId: schedule.id, jobId, status: 'completed' });
        log(`fired ${schedule.id} "${schedule.name}" → ${schedule.contactId}`);
        fired++;
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        appendLog({
          firedAt, scheduleId: schedule.id, jobId, status: 'failed', error: msg,
        });
        log(`fire failed ${schedule.id}: ${msg}`);
      }
    }
  } catch (e) {
    log('tick error', (e as Error)?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: ToolPlugin = {
  name: 'schedule',
  description:
    'Manage proactive reminders/schedules for this conversation. Use this when the user asks you '
    + 'to do something later or on a recurring basis ("remind me every morning at 8", "run this at '
    + '6pm", "every hour check X"). The schedule fires as a synthetic turn in the same chat at the '
    + 'scheduled time, with the stored prompt as if the user had just asked it. '
    + 'Supported "when" formats (UTC): "once@2026-04-15T18:00:00Z" for one-shot, "daily@08:00" for '
    + 'every day at that UTC time, "every@3600" for every N seconds from creation. Convert the '
    + "user's local time to UTC before passing it in. Actions: create, list, cancel.",
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'cancel'],
        description:
          'What to do. "create" adds a new schedule. "list" shows existing schedules for this '
          + 'conversation. "cancel" deletes one by id (get the id from list first).',
      },
      name: {
        type: 'string',
        description: 'Short human-readable label for the schedule, e.g. "morning briefing". (create only)',
      },
      when: {
        type: 'string',
        description:
          'When the schedule should fire. Formats: "once@<ISO-UTC>" one-shot, "daily@HH:MM" every '
          + 'day at HH:MM UTC, "every@<seconds>" interval from creation. (create only)',
      },
      prompt: {
        type: 'string',
        description:
          'The instruction you will receive when this schedule fires. Write it as if the user '
          + 'were asking it fresh ("Summarise yesterday\'s activity"). Keep it self-contained — '
          + 'by the time it fires there may be no recent conversation context. (create only)',
      },
      id: {
        type: 'string',
        description: 'Schedule id to cancel (from a prior list call). (cancel only)',
      },
    },
    required: ['action'],
  },

  async start(ctx: ToolStartCtx): Promise<() => void> {
    const stateDir = join(ctx.pluginDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    schedulesPath = join(stateDir, 'schedules.json');
    logPath = join(stateDir, 'log.jsonl');
    log = ctx.log;
    fireSystemTurn = ctx.fireSystemTurn;

    schedulesCache = loadSchedules();
    recoverOrphanClaims();

    // Fire one immediate tick so schedules that came due while the process
    // was down get picked up right away.
    void tick();
    tickTimer = setInterval(() => { void tick(); }, TICK_MS);

    return () => {
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    };
  },

  async execute(input, ctx) {
    // Guard: if execute() runs before start() (shouldn't happen, but defensive
    // against misconfigured loads), surface a clear error rather than
    // silently writing to the wrong path.
    if (!schedulesPath) {
      return 'error: schedule tool start() was not called — reinstall or check logs';
    }

    const action = String(input.action || '').trim();

    if (action === 'list') {
      const mine = schedulesCache.filter(s => s.contactId === ctx.contactId);
      if (mine.length === 0) return 'No schedules set for this conversation.';
      return mine
        .map(s => `${s.id} — "${s.name}" (${s.schedule}) → ${s.prompt}`)
        .join('\n');
    }

    if (action === 'create') {
      const name   = typeof input.name === 'string' ? input.name.trim() : '';
      const when   = typeof input.when === 'string' ? input.when.trim() : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!name || !when || !prompt) {
        return 'error: create requires name, when, and prompt';
      }

      const schedule: Schedule = {
        id: 'sch_' + randomUUID().slice(0, 8),
        name,
        schedule: when,
        prompt,
        channel:   ctx.channel,
        chatId:    ctx.chatId,
        contactId: ctx.contactId,
        createdAt: new Date().toISOString(),
      };

      // Validate eagerly — computeNextFire returns null iff the format is
      // unparseable, giving the agent a clear error instead of a silent
      // "never fires".
      if (!computeNextFire(schedule, null)) {
        return `error: invalid schedule "${when}" — expected one of: `
          + `once@<ISO-UTC>, daily@HH:MM, every@<seconds>`;
      }

      schedulesCache.push(schedule);
      saveSchedules();
      return `Scheduled "${schedule.name}" (id=${schedule.id}) — will fire per ${schedule.schedule}.`;
    }

    if (action === 'cancel') {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (!id) return 'error: cancel requires id';
      const before = schedulesCache.length;
      schedulesCache = schedulesCache.filter(s => s.id !== id);
      if (schedulesCache.length === before) return `No schedule found with id ${id}.`;
      saveSchedules();
      return `Cancelled schedule ${id}.`;
    }

    return `error: unknown action '${action}'. Valid: create, list, cancel.`;
  },
};

export default plugin;
