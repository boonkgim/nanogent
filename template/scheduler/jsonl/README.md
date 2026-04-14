# scheduler/jsonl — default scheduler plugin

Time-based proactive triggers. The agent uses the bundled `schedule` tool to
create, list, and cancel schedules; this plugin stores them and tells the
core runtime which ones are due on each tick.

## On-disk layout

Two files under `.nanogent/state/`:

```
schedules.json         — immutable definitions (rules the agent set up)
schedule-log.jsonl     — append-only execution log (claims, completions, failures)
```

Keeping them separate means the rules file is a clean source of truth the
agent CRUDs, while per-fire state (what actually ran, when, with what status)
lives in the append-only log. Restart recovery reads the log to fail-forward
any orphan `claimed` entries from a crashed previous run so the schedule
becomes eligible to fire again on its next computed time.

### schedules.json

```json
{
  "schedules": [
    {
      "id": "sch_abcd1234",
      "name": "morning briefing",
      "schedule": "daily@08:00",
      "prompt": "Summarise yesterday's activity and list today's priorities.",
      "channel": "telegram",
      "chatId": "123456789",
      "contactId": "telegram_dm_123456789",
      "createdAt": "2026-04-15T10:30:00.000Z"
    }
  ]
}
```

### schedule-log.jsonl

One JSON object per line, append-only:

```
{"firedAt":"2026-04-16T08:00:00.000Z","scheduleId":"sch_abcd1234","jobId":"job_ef567890","status":"claimed"}
{"firedAt":"2026-04-16T08:00:00.000Z","scheduleId":"sch_abcd1234","jobId":"job_ef567890","status":"completed"}
```

## Schedule string formats

The `schedule` field on every definition is a plugin-defined string. This
default implementation understands three shapes:

| Format              | Meaning                                    | Example                        |
|---------------------|--------------------------------------------|--------------------------------|
| `once@<ISO-UTC>`    | One-shot; fires once at the given instant. | `once@2026-04-15T18:00:00Z`    |
| `daily@HH:MM`       | Every day at `HH:MM` UTC.                  | `daily@08:00`                  |
| `every@<seconds>`   | Every N seconds from creation.             | `every@3600` (hourly)          |

Unknown formats fail fast at `createSchedule` time rather than sitting
silently in `schedules.json` and never firing.

**Time zones.** `daily@HH:MM` is UTC. The agent is responsible for computing
the correct UTC wall-clock time if the user asks "every day at 8am" in a
non-UTC time zone — it can read the user's locale from its system prompt or
ask. A richer `daily@HH:MM@<tz>` format is a future extension.

## Operator ops

* Inspect rules: `cat .nanogent/state/schedules.json | jq`
* Inspect runs: `tail -f .nanogent/state/schedule-log.jsonl`
* Clear everything: `rm .nanogent/state/schedules.json .nanogent/state/schedule-log.jsonl`

Both files are under `state/` and are gitignored by the core `.gitignore`.

## Writing an alternative scheduler plugin

The contract (`SchedulerPlugin` in `types.d.ts`) is ten methods — five for
definition CRUD and four for execution + one for introspection. An
alternative backend (sqlite, pg-boss, redis) just has to preserve the
atomicity promise on `claimDue`: a claimed job must not be returned by a
second `claimDue` call until `markComplete` or `markFailed` runs. The jsonl
default achieves this via a `claimed` log entry; a SQL backend would use
`SELECT ... FOR UPDATE SKIP LOCKED`. Core doesn't care.

See DESIGN.md DR-010 for the full rationale.
