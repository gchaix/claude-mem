# tag1 fork notes

This is the tag1-patched fork of claude-mem (`gchaix/claude-mem`), tracking upstream `thedotmack/claude-mem`. The patched plugin is deployed from this fork's `main` branch via the Claude plugin marketplace. Releases carry a `-tag1.N` pre-release suffix (e.g. `13.6.1-tag1.1`).

## tag1 patches carried on top of upstream

- Bedrock corporate-proxy support (env injection, model-id selection, rate-limit/quota exemption for API-key auth).
- Daemon resilience: worker `cwd` set to home dir.
- Observer-session guard: internal observer sessions skip worker submission (server-side in `SessionRoutes`, and in every hook handler via `shouldTrackProject(cwd)`).
- Hostname-on-observations: nullable `hostname` column on `sdk_sessions` (migration 37), captured at the hook layer so observations are attributed to the originating machine in a remote-worker topology. Surfaced in read paths and the UI.
- Durable offline event queue for remote-worker outages (separate `offline_event_queue` table, migration 36).
- `observation_add` enabled in worker mode.

## Known-acceptable test failures

The suite is not 0-fail. The following failures are expected and are NOT tag1 regressions. As of the v13.6.1-tag1.1 port the full suite is 2277 pass / 11 fail; all 11 are accounted for here.

### Upstream-baseline failures (10) — present on bare upstream v13.6.1, not caused by tag1

- `server-beta boot: mode loading (#2443)` — 2 tests
- `server runtime in-process smoke (#2550) > loads a mode at boot` — 1 test
- `worker-json-status` — 7 tests

These fail on a clean checkout of the upstream `v13.6.1` tag with no tag1 patches applied. They are upstream's to fix.

### Accepted fork divergence (1)

- `MigrationRunner > fresh database initialization > should tighten legacy pending_messages status checks from old migration 28 databases`

  Upstream v13.6.1 drops `retry_count` (and narrows the `pending_messages` status CHECK) when migrating legacy databases. tag1 migration 35 intentionally retains `retry_count` and the `failed` status. These columns are currently vestigial (no runtime code reads or writes them; the offline queue uses the separate `offline_event_queue` table), but the migration is left as-is on purpose: aligning with upstream would run a destructive `ALTER ... DROP COLUMN` against the live shared production database on the worker host, and the benefit (removing unused columns) does not justify that risk. Decision recorded 2026-06-15: leave this test failing as a documented divergence rather than edit the migration or the test.

  Revisit only as a deliberate, backed-up migration if the columns are ever confirmed safe to drop.

## Forward-port / deploy

Updates are produced by the `claude-mem-update` workflow: forward-port the patches onto the latest upstream release, build, run the suite (expect only the known failures above), publish to this fork's `main`, then deploy from the fork across the worker host and thin clients.
