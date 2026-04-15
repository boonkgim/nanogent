# history/jsonl

Default history store for nanogent. Append-only JSONL files, one per
`contactId`, under this plugin's own state dir
(`.nanogent/history/jsonl/state/`). Per DR-014, plugins own their state
location — the core never reaches in.

This plugin is intentionally **dumb**. It does not rotate, summarise, or
filter — it's the raw log of everything that was said. Boundary-aware
windowing is a core invariant (`NANOGENT_HISTORY_WINDOW`, default 80);
per-turn retrieval/summarisation/RAG is a tool concern via the
`contributeContext` hook (see DR-016).

## File layout

```
.nanogent/history/jsonl/state/
  alice_dm.jsonl
  project_group.jsonl
  public_helpdesk__stranger_at_x_com.jsonl   (per-user mode; "/" sanitized to "__")
```

Each line is one `HistoryMessage` JSON object:

```json
{"role":"user","content":"[Alice]: hi"}
{"role":"assistant","content":[{"type":"text","text":"hey!"}]}
```

The on-disk line format is unchanged since v0.4.x, but v0.11.0 moved the
files from `.nanogent/state/history/` into this plugin's own
`.nanogent/history/jsonl/state/` directory (see README.md migration notes).

## Contract

Implements `HistoryStorePlugin` from `../../types.d.ts`:

- **`append(contactId, messages)`** — O(n) load from disk (first call), O(1)
  in-memory append thereafter, one file rewrite per append batch.
- **`read(contactId, { limit? })`** — returns a copy of the stored messages,
  optionally windowed to the last N.
- **`retractLast(contactId, count)`** — truncates the tail. Used by the core
  on `skip` and error recovery.
- **`clear(contactId)`** — unlinks the file.

## Replacing it

To swap this for a database-backed history store (Postgres, SQLite, Redis,
etc.), drop a folder at `.nanogent/history/<your-name>/` with an `index.ts`
that default-exports a `HistoryStorePlugin`, then delete this folder. The
core loads whatever is present — exactly one history store must be active.

## State & gitignore

The state directory (`.nanogent/history/jsonl/state/`) is hidden by this
plugin's own `.gitignore` (shipped as `gitignore` in source and renamed on
install), per DR-014 — plugins own their own gitignore story.

## See also

- [DESIGN.md DR-014](../../../DESIGN.md#dr-014-minimal-coupling-between-core-and-plugins) — minimal core↔plugin coupling; plugins own their own state location.
- [DESIGN.md DR-016](../../../DESIGN.md#dr-016-memory-is-not-a-plugin-type-tools-contribute-context-via-a-hook) — why there is no memory plugin type; tools contribute per-turn context via a hook.
