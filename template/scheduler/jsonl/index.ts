// scheduler/jsonl — default scheduler for nanogent.
//
// Two files under .nanogent/state/:
//   schedules.json        — immutable definitions (CRUD'd by the agent tool)
//   schedule-log.jsonl    — append-only execution log (claims, completions, failures)
//
// The definitions file holds only schedule rules (name, cron-ish expression,
// prompt, delivery route). Mutable per-fire state lives in the log. Separating
// them keeps the definitions file a pure source of truth the agent edits, and
// lets execution state grow without touching the rules.
//
// Schedule string formats this plugin understands:
//   once@<ISO-UTC>     one-shot, e.g. "once@2026-04-15T18:00:00Z"
//   daily@HH:MM        every day at HH:MM UTC, e.g. "daily@08:00"
//   every@<seconds>    interval from creation, e.g. "every@3600" (hourly)
//
// See DESIGN.md DR-010.

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  ClaimedJob, Schedule, ScheduleExecution, ScheduleSpec, SchedulerCtx,
  SchedulerPlugin,
} from '../../types.d.ts';

let schedulesPath = '';
let logPath = '';
let log: (...args: unknown[]) => void = () => {};

// In-memory cache of definitions. Loaded on init, mutated on create/delete,
// flushed to disk on every mutation. Tiny file — a full rewrite is cheap.
let schedulesCache: Schedule[] = [];

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
    log('schedule-log.jsonl read error', (e as Error)?.message || e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schedule string parsing and next-fire computation
// ---------------------------------------------------------------------------

/**
 * Compute the next time this schedule should fire. Returns null if the
 * schedule is invalid, has no future fire time, or is a one-shot that has
 * already fired (lastFiredAt is non-null).
 *
 * `lastFiredAt` is the most recent *successful* fire, or null if the
 * schedule has never fired.
 */
function computeNextFire(schedule: Schedule, lastFiredAt: Date | null): Date | null {
  const s = (schedule.schedule || '').trim();

  if (s.startsWith('once@')) {
    if (lastFiredAt) return null;                     // one-shot, done
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
    // If the computed time is at-or-before the anchor, the HH:MM for today
    // has already passed relative to the anchor — roll forward one day.
    if (next <= anchor) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Execution log indexing
// ---------------------------------------------------------------------------

interface LogIndex {
  // scheduleId → most recent successful fire
  lastSuccess: Map<string, Date>;
  // scheduleIds currently in-flight (claimed but not marked complete/failed)
  inFlight: Set<string>;
  // jobId → list of entries (used for orphan recovery)
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
      // The firedAt on the first (claim) entry is the canonical fire time.
      const firedAt = new Date(js[0]!.firedAt);
      const prev = lastSuccess.get(last.scheduleId);
      if (!prev || firedAt > prev) lastSuccess.set(last.scheduleId, firedAt);
    }
    // 'failed' contributes neither a success nor an in-flight mark — the
    // schedule becomes eligible to fire again on its next computed time.
  }

  return { lastSuccess, inFlight, byJob };
}

/**
 * If a previous process crashed between `claimed` and `completed`/`failed`,
 * the corresponding scheduleId stays in `inFlight` forever and the schedule
 * can never fire again. On boot, fail-forward any such orphan claims so the
 * schedule becomes eligible again on its next computed time.
 */
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
// Plugin
// ---------------------------------------------------------------------------

const plugin: SchedulerPlugin = {
  name: 'jsonl',

  async init(ctx: SchedulerCtx): Promise<void> {
    schedulesPath = join(ctx.stateDir, 'schedules.json');
    logPath = join(ctx.stateDir, 'schedule-log.jsonl');
    log = ctx.log;
    mkdirSync(ctx.stateDir, { recursive: true });
    schedulesCache = loadSchedules();
    recoverOrphanClaims();
  },

  async createSchedule(spec: ScheduleSpec): Promise<Schedule> {
    // Validate the schedule string format eagerly so the agent gets a clear
    // error instead of a silent "never fires". computeNextFire with a null
    // last-fire will return null iff the format is unparseable.
    const probe: Schedule = {
      ...spec,
      id: '_probe',
      createdAt: new Date().toISOString(),
    };
    if (!computeNextFire(probe, null)) {
      throw new Error(
        `invalid schedule "${spec.schedule}" — expected one of: `
        + `once@<ISO-UTC>, daily@HH:MM, every@<seconds>`,
      );
    }

    const schedule: Schedule = {
      ...spec,
      id: 'sch_' + randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
    };
    schedulesCache.push(schedule);
    saveSchedules();
    return schedule;
  },

  async listSchedules(filter?: { contactId?: string }): Promise<Schedule[]> {
    if (filter?.contactId) {
      return schedulesCache.filter(s => s.contactId === filter.contactId).slice();
    }
    return schedulesCache.slice();
  },

  async getSchedule(id: string): Promise<Schedule | null> {
    return schedulesCache.find(s => s.id === id) || null;
  },

  async deleteSchedule(id: string): Promise<boolean> {
    const before = schedulesCache.length;
    schedulesCache = schedulesCache.filter(s => s.id !== id);
    if (schedulesCache.length === before) return false;
    saveSchedules();
    return true;
  },

  async claimDue(now: Date, limit = 10): Promise<ClaimedJob[]> {
    const { lastSuccess, inFlight } = indexLog(readLog());
    const due: ClaimedJob[] = [];

    for (const schedule of schedulesCache) {
      if (due.length >= limit) break;
      if (inFlight.has(schedule.id)) continue;
      const lastFired = lastSuccess.get(schedule.id) || null;
      const nextFire = computeNextFire(schedule, lastFired);
      if (!nextFire) continue;
      if (nextFire > now) continue;

      const jobId = 'job_' + randomUUID().slice(0, 8);
      const firedAt = nextFire.toISOString();
      appendLog({ firedAt, scheduleId: schedule.id, jobId, status: 'claimed' });
      due.push({ jobId, schedule, firedAt });
    }
    return due;
  },

  async markComplete(jobId: string): Promise<void> {
    // Find the claim entry for this jobId so we can carry the scheduleId +
    // firedAt forward on the completion record. This lets listExecutions
    // answer "which fire completed" without cross-referencing the claim.
    const entries = readLog();
    const claim = entries.find(e => e.jobId === jobId && e.status === 'claimed');
    if (!claim) {
      log(`markComplete: no claim found for jobId=${jobId}, appending anyway`);
    }
    appendLog({
      firedAt: claim?.firedAt || new Date().toISOString(),
      scheduleId: claim?.scheduleId || 'unknown',
      jobId,
      status: 'completed',
    });
  },

  async markFailed(jobId: string, error: string): Promise<void> {
    const entries = readLog();
    const claim = entries.find(e => e.jobId === jobId && e.status === 'claimed');
    if (!claim) {
      log(`markFailed: no claim found for jobId=${jobId}, appending anyway`);
    }
    appendLog({
      firedAt: claim?.firedAt || new Date().toISOString(),
      scheduleId: claim?.scheduleId || 'unknown',
      jobId,
      status: 'failed',
      error,
    });
  },

  async listExecutions(filter?: { scheduleId?: string; limit?: number }): Promise<ScheduleExecution[]> {
    let entries = readLog();
    if (filter?.scheduleId) {
      entries = entries.filter(e => e.scheduleId === filter.scheduleId);
    }
    if (filter?.limit && filter.limit > 0 && entries.length > filter.limit) {
      return entries.slice(-filter.limit);
    }
    return entries;
  },
};

export default plugin;
