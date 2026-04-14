# schedule — agent-facing tool for proactive reminders

Lets the chat agent create, list, and cancel time-based reminders for the
current conversation. When a schedule fires, the core runtime injects a
synthetic turn into the same chat using the stored prompt as the trigger
text — the agent sees it as if the user had just asked.

## How the agent uses it

The tool takes a single `action` parameter that routes to one of three
operations:

### `create` — add a new schedule

```
action: "create"
name:   "morning briefing"
when:   "daily@08:00"
prompt: "Summarise yesterday's activity and list today's priorities."
```

Supported `when` formats (all UTC — convert from the user's local time
before calling):

| Format              | Meaning                                | Example                        |
|---------------------|----------------------------------------|--------------------------------|
| `once@<ISO-UTC>`    | Fire once at this instant.             | `once@2026-04-15T18:00:00Z`    |
| `daily@HH:MM`       | Fire every day at HH:MM UTC.           | `daily@08:00`                  |
| `every@<seconds>`   | Fire every N seconds from creation.    | `every@3600` (hourly)          |

Write `prompt` so it's self-contained — by the time the schedule fires,
there may be no recent conversation context, so "Summarise yesterday" is
better than "Do that thing we talked about".

### `list` — show schedules for this conversation

Returns one line per active schedule with its id, name, when, and prompt.

### `cancel` — delete a schedule

```
action: "cancel"
id:     "sch_abcd1234"
```

Get the id from a prior `list` call.

## Delivery route

The channel, chatId, and contactId are captured from the turn where the
schedule was created — you don't pass them in, and the schedule fires back
to the same conversation. A schedule created in a Telegram DM with Alice
always fires in that DM, even if the same agent is reachable through other
channels.

## When there's no scheduler

If the operator hasn't installed a scheduler plugin (`.nanogent/scheduler/`
is empty), this tool returns a clear error on every call. The `schedule`
tool is installed by default but is inert without a scheduler backend.

## Why a single tool with actions instead of three

Three tightly-related operations on one resource. One tool with an
`action` discriminator keeps the agent's tool list short, keeps related
docs in one place, and matches how the chat agent naturally reasons
about schedules ("I want to schedule-create this" vs. "I want to call
schedule, action create"). Three separate tools would duplicate
descriptions and leak implementation structure into the agent's view.
