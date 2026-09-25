# AGENTS.md

Notes for agents working on this repo. Everything below was verified against live
traces, not inferred.

## Settled decisions: do not "fix" these

Each of these looks like a bug and is not. Check here before filing one.

- **`gen_ai.usage.input_tokens` sums three fields.** `buildUsage` in
  `src/genaiSpans.ts` adds Anthropic's `input_tokens`, `cache_read_input_tokens`
  and `cache_creation_input_tokens`, because OTel defines input tokens as the
  total prompt. The cache fields are also emitted separately as the breakdown,
  which reads like double counting but is not. See the comment and the semconv
  link at the function.
- **A turn's last `chat` span appears only at Stop.** Earlier ones are sent at
  root `PreToolUse` (`Session.emitCompletedResponses`). Claude Code writes the
  rest of a response after running its tool, and a sent span cannot be amended.
- **The first `chat` span carries the user prompt** as `gen_ai.input.messages`,
  not the full model input, because the root span exports only at turn close.
- **`status_code: UNSET` on a successful span is correct.** OTel reserves `Ok`
  for explicit developer intent; UNSET is the success default. Failures already
  route through `span.end({ error })`, which sets ERROR plus `error.type`.

## Verifying traces

Agent spans go to the W&B Agents store at
`https://trace.wandb.ai/agents/otel/v1/traces`, which is separate from classic
Weave calls. The `weave-calls` MCP tools read 0 from it even when the project is
full, so query the agents endpoints directly:

```bash
curl -s -u "api:$WANDB_API_KEY" -X POST https://trace.wandb.ai/agents/spans/query \
  -H 'Content-Type: application/json' \
  -d '{"project_id":"<entity>/<project>","limit":50,"include_details":true,
       "sort_by":[{"field":"started_at","direction":"desc"}]}'
```

Three request-shape traps that produce believable but wrong conclusions:

- `sort_by` must be a list of `{field, direction}`. A bare string 422s.
- Tool payload columns (`tool_call_arguments`, `tool_call_result`, `tool_type`)
  populate only with `include_details: true`. Without it they read empty, which
  looks exactly like the client failing to record them.
- `raw_span_dump.attributes` comes back nested, because the server parses
  JSON-string attribute values. Recursively flattening it turns one wire
  attribute (`gen_ai.tool.call.arguments`) into many dotted sub-keys
  (`gen_ai.tool.call.arguments.command`). Do not infer the wire format from a
  flattened view.

For an end-to-end check, drive the real `Daemon` with the real OTLP exporter
(`weave.init(project)` with no span-processor override), route synthetic hook
events through `routeEvent`, `await weave.flushOTel()`, then read the spans back
with the query above. `tests/helpers.ts` has the in-memory equivalent for unit
tests.

Export failures are invisible by default: a bad key or an unwritable project
drops every span while hooks keep succeeding and the log rotates. Before trusting
an empty project, grep the daemon log for `OTLPExporterError`. Surfacing the last
rejection through `weave-claude-code status` is in flight on
`feat/status-export-health`.

## Transcript lifecycle

Claude Code creates the session transcript *after* `SessionStart`, so any hook
that fires early can see a path that does not exist yet. `TranscriptFile.getFd()`
throws in that window and caches the fd once it succeeds.

Read through `Session.parseTranscript()`, which treats an unreadable transcript
as empty. A bare `parseSessionFd(this.transcript.getFd())` in a turn-creation
path lets ENOENT escape to the dispatcher and drops the whole hook, which is how
the first prompt of every new session went untraced.

## Config

`resolveApiKey` and `resolveProject` in `src/config.ts` prefer the environment
over `settings.json`. A revoked key in `settings.json` therefore stays hidden as
long as `WANDB_API_KEY` is exported, and only surfaces for anything launched
without it. `weave-claude-code status` prints which source won.

The daemon inherits the environment of whatever spawned it, so a daemon started
from a shell without `WANDB_API_KEY` resolves a different key than your terminal
does. `ps eww -p <pid>` shows what it actually got.

## Known gaps

- **No content gate or redactor.** Tool arguments, tool results, prompts and
  model output are written to spans raw. A `Bash` step that prints a credential
  puts that credential in `gen_ai.tool.call.result.stdout`. Any payload capture
  added here inherits that exposure until a gate lands.
- `chat` spans carry `gen_ai.agent.name` but not `gen_ai.agent.version`.
  `agent_name` is the join key, so attribution works without it.

## Checks

`npm run check` runs `tsc` then the full suite. Run it before pushing. Tests live
in `tests/` mirroring `src/`, grouped per concern rather than per fix.
