# Memory Bank (1.1 design)

The context rethink: stop treating the context window as the memory. Memory
becomes a per-project bank on disk; the window becomes a small working buffer.
Per-turn cost becomes O(1) in history size, and model switching is always safe
because every request is small by construction.

## Principles (decided 2026-07-23)

1. **Keep everything, verbatim, forever.** No distillation ever deletes or
   replaces raw history. Summaries are an *index over* the archive, never a
   substitute for it. Loss may exist in the default view, never in the record.
2. **The window is RAM.** Each turn ships: a bounded digest (≤ ~1.5k tokens)
   rendered from the index + the recent turns verbatim. Chat UI keeps showing
   the full conversation — display and model context are decoupled.
3. **Paging over recollection.** The model gets tools (`map_query`,
   `archive_read`) to pull exact verbatim spans on demand. If a signpost
   (summary node) is wrong, ground truth is one tool call away.
4. **SQLite, one file, from day one.** `userData/membank.sqlite` with FTS5 for
   full-text search. No JSON-file phase, no migration later. Scales to years
   of use (500 sessions ≈ 0.1–0.4 GB total).
5. **Project deletion = purge + epitaph.** Deleting a project removes its rows
   from the bank (archive, index, FTS). Before purging, a brief overview —
   what the project was, when, what it was about — is written to the global
   journal so Vodo can always answer "what was that project I did in July?".

## Storage model

- **Archive** (lossless): every message/tool result, keyed by project/session/
  turn. The existing `chats/*.json` transcripts migrate in; the journal stays
  as the cross-project episodic timeline.
- **Index / map** (bounded, structured): typed nodes — `file`, `component`,
  `decision`, `task`, `fact`, `issue`, `preference` — short bodies, tags,
  status, and links (`imports`, `depends-on`, `decided-because`, `supersedes`).
  Facts-about-the-project live here (hundreds of nodes, bounded); events live
  in the archive (unbounded, cheap). Stale facts are superseded via status
  edges, not duplicated.
- **FTS5** over archive + node bodies for retrieval; ranking = project scope
  first, then time-decay + keyword relevance.

## Write path

A distiller (cheapest adequate model, triggered when the buffer crosses a
threshold or a run ends) reads only the new turns and emits structured ops:
`upsert_node`, `link`, `set_status`. Ops are validated and applied; every node
records the archive spans it came from. Fail-soft: if distillation fails,
behavior degrades to today's full-replay within the session.

## Read path

Turn assembly = system prompt + digest (project overview node + top-K nodes
relevant to the current message, hard token budget) + recent buffer (cut at
user-message boundaries only, preserving tool_call/result pairs). Older turns
drop out of the request — never out of the archive.

## Build order

1. SQLite archive + FTS + `archive_read`/search tools (pure lossless win).
2. Index layer + distiller + `map_query`.
3. Auto-assembly (digest + buffer) — opt-in per project until proven.
4. Memory view in the UI (see and edit the map).

## Trade-off accepted

The model must think to look: what isn't in the digest or buffer is absent
until queried. Mitigated by relevance-ranked digests; accepted as the same
contract a human has with a notebook.
