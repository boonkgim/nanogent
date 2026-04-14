# history/jsonl

Default history store for nanogent. Append-only JSONL files, one per
`contactId`, under `.nanogent/state/history/`.

This plugin is intentionally **dumb**. It does not rotate, summarise, or
filter — it's the raw log of everything that was said. Windowing, relevance
ranking, and retrieval are the **memory plugin's** job (see
`.nanogent/memory/`).

## File layout

```
.nanogent/state/history/
  alice_dm.jsonl
  project_group.jsonl
  public_helpdesk__stranger_at_x_com.jsonl   (per-user mode; "/" sanitized to "__")
```

Each line is one `HistoryMessage` JSON object:

```json
{"role":"user","content":"[Alice]: hi"}
{"role":"assistant","content":[{"type":"text","text":"hey!"}]}
```

The format matches v0.4.x on disk — upgrading to v0.5.0 keeps existing files
readable with no migration step.

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

The state directory (`.nanogent/state/history/`) is gitignored by the
`.nanogent/.gitignore` file the CLI drops on `init`.

## See also

- [DESIGN.md DR-009a](../../../DESIGN.md) — why history storage is separated
  from memory.
- [../../memory/naive/README.md](../../memory/naive/README.md) — the default
  memory plugin that sits on top of this store.
