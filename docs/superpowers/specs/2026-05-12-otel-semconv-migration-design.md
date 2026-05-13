# OTel GenAI Semantic Conventions Migration

**Date:** 2026-05-12
**Author:** Rick Gao (via brainstorming)
**Status:** Approved for implementation

## Goal

Migrate the `weave-claude-plugin` from the Weave JavaScript SDK (`/call/start` + `/call/end` API) to the new OTel GenAI ingest endpoint in core, emitting standard `gen_ai.*` semantic conventions so that traces appear in the Weave Agents observability surface.

## Decisions

1. **Hard cut-over** — drop the `weave` npm dependency; replace with the OTel JS SDK + OTLP/HTTP-protobuf exporter.
2. **Endpoint:** `${WANDB_BASE_URL}/agents/otel/v1/traces` (defaults if unset). Auth via `wandb-api-key` HTTP header.
3. **Span topology:** one trace per Claude Code session. Tree:

   ```
   invoke_agent claude-code               (session root)
   └─ invoke_agent claude-code            (one per user prompt — "turn")
      ├─ chat <model>                     (each LLM API call, emitted at Stop)
      ├─ execute_tool <tool_name>         (each tool call)
      └─ invoke_agent <subagent_type>     (each subagent — flat sibling of execute_tool Agent)
         ├─ chat
         └─ execute_tool
   ```

4. **Subagent placement:** flat under the turn-level `invoke_agent`, sibling of the `execute_tool Agent` that spawned it. Linked via `weave.claude_code.subagent.spawning_tool_call_id` attribute.
5. **Attribute namespace:** `gen_ai.*` for the OTel GenAI semconv catalog; `weave.*` for Claude-Code-specific extensions with no semconv equivalent.
6. **Permission requests:** OTel span event (`weave.permission_request`) on the parent `execute_tool` span, with `weave.permission.approved` (bool) and `weave.permission.suggestions` (json) event attributes.
7. **Chat spans:** emitted at `Stop` from parsed transcript. Timestamps backdated from transcript message times so the trace UI plots them in real order.
8. **Compaction:** `PreCompact` hook emits a `weave.compaction` span event on the session span with `weave.compaction.summary`, `weave.compaction.items_before`, `weave.compaction.items_after`.
9. **Other hooks** (`Notification`, `InstructionsLoaded`, `ConfigChange`, `WorktreeCreate/Remove`, `TeammateIdle`, `TaskCompleted`): remain ignored. No span/event emitted. Scope-contained.

## Span schema

### Session span (root)

| Attribute | Value |
|---|---|
| `span.name` | `"invoke_agent claude-code"` |
| `span.kind` | `INTERNAL` |
| `gen_ai.operation.name` | `"invoke_agent"` |
| `gen_ai.provider.name` | `"anthropic"` |
| `gen_ai.agent.name` | `"claude-code"` |
| `gen_ai.conversation.id` | `<session_id>` |
| `weave.claude_code.session.id` | `<session_id>` |
| `weave.claude_code.cwd` | working directory |
| `weave.claude_code.source` | `startup` / `resume` / `clear` |
| `weave.claude_code.plugin.version` | plugin version |
| Closed at `SessionEnd` with | `weave.claude_code.session.end_reason`, `weave.claude_code.turn.count`, `weave.claude_code.tool.count`, `weave.claude_code.tool.counts` (json string) |

No `gen_ai.usage.*` on the session — keeps it zero so queries roll up from child chat spans without double-counting.

### Turn span (one per user prompt)

| Attribute | Value |
|---|---|
| `span.name` | `"invoke_agent claude-code"` |
| `span.kind` | `INTERNAL` |
| parent | session span |
| `gen_ai.operation.name` | `"invoke_agent"` |
| `gen_ai.provider.name` | `"anthropic"` |
| `gen_ai.agent.name` | `"claude-code"` |
| `gen_ai.conversation.id` | `<session_id>` |
| `gen_ai.input.messages` | `[{"role": "user", "content": "<prompt>"}]` |
| `gen_ai.output.messages` | final assistant text only (set at Stop) |
| `gen_ai.response.finish_reasons` | from last chat call in turn |
| `weave.claude_code.turn.number` | int |
| `weave.claude_code.turn.tool_count` | int |

### Chat spans (one per LLM API call, emitted at Stop)

| Attribute | Value |
|---|---|
| `span.name` | `"chat <model>"` |
| `span.kind` | `CLIENT` |
| parent | turn invoke_agent (or subagent invoke_agent if from subagent transcript) |
| `started_at` | timestamp of preceding transcript message |
| `ended_at` | timestamp of this assistant message |
| `gen_ai.operation.name` | `"chat"` |
| `gen_ai.provider.name` | `"anthropic"` |
| `gen_ai.request.model` | from transcript |
| `gen_ai.response.model` | from transcript (if differs) |
| `gen_ai.response.id` | from transcript (if present) |
| `gen_ai.conversation.id` | `<session_id>` |
| `gen_ai.usage.input_tokens` | per-call |
| `gen_ai.usage.output_tokens` | per-call |
| `gen_ai.usage.reasoning_tokens` | per-call (if any) |
| `gen_ai.usage.cache_read.input_tokens` | per-call |
| `gen_ai.usage.cache_creation.input_tokens` | per-call |
| `gen_ai.response.finish_reasons` | array |
| `gen_ai.input.messages` | message history sent to this call (json string) |
| `gen_ai.output.messages` | assistant blocks returned (json string) |
| `gen_ai.output.type` | `"text"` |

### Tool spans

| Attribute | Value |
|---|---|
| `span.name` | `"execute_tool <tool_name>"` |
| `span.kind` | `INTERNAL` |
| parent | turn invoke_agent (or subagent invoke_agent if `agent_id` set) |
| `gen_ai.operation.name` | `"execute_tool"` |
| `gen_ai.tool.name` | tool name |
| `gen_ai.tool.call.id` | `<tool_use_id>` |
| `gen_ai.provider.name` | `"anthropic"` |
| `gen_ai.tool.call.arguments` | `tool_input` as JSON string |
| `gen_ai.tool.call.result` | `tool_response` as JSON string |
| `error.type` | on failure; span status set to `ERROR` |
| Span event | `weave.permission_request` at PermissionRequest hook |

### Subagent spans

| Attribute | Value |
|---|---|
| `span.name` | `"invoke_agent <subagent_type>"` |
| `span.kind` | `INTERNAL` |
| parent | turn invoke_agent (flat) |
| `gen_ai.operation.name` | `"invoke_agent"` |
| `gen_ai.provider.name` | `"anthropic"` |
| `gen_ai.agent.name` | `<subagent_type>` |
| `gen_ai.agent.id` | `<agent_id>` |
| `gen_ai.conversation.id` | `<session_id>:<agent_id>` |
| `weave.claude_code.subagent.spawning_tool_call_id` | `<tool_use_id>` of spawning `execute_tool Agent` |

### Span events

| Hook | Event name | Attached to | Emit timing | Event attributes |
|---|---|---|---|---|
| `PermissionRequest` → `PostToolUse[Failure]` | `weave.permission_request` | parent `execute_tool` | Emitted at `PostToolUse[Failure]` with `timestamp=permissionStartedAt` so the event appears at the moment the permission was requested. | `weave.permission.approved` (bool), `weave.permission.suggestions` (JSON string) |
| `PreCompact` | `weave.compaction` | session `invoke_agent` | Emitted at `PreCompact` time. | `weave.compaction.summary` (string), `weave.compaction.items_before` (int), `weave.compaction.items_after` (int) |

### Attribute value encoding

OTel span/event attribute values must be primitives (string, number, boolean, or homogeneous arrays of those). Structured values are JSON-stringified:

- `gen_ai.input.messages`, `gen_ai.output.messages` → JSON string of `[{role, content}, ...]`. The Weave extractor handles both JSON strings and structured arrays.
- `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` → JSON string.
- `gen_ai.tool.definitions` → JSON string (if emitted).
- `gen_ai.response.finish_reasons` → array of strings (native OTel `string[]`).
- `gen_ai.system_instructions` → JSON string.
- `weave.claude_code.tool.counts` → JSON string.
- `weave.permission.suggestions` → JSON string.

## Architecture

### Module layout

```
src/
├─ cli.ts              (unchanged)
├─ setup.ts            (unchanged)
├─ daemon.ts           (rewritten — orchestrates OTel TracerProvider + span lifecycle)
├─ genaiSpans.ts       (NEW — semconv attribute builders, transcript → chat span helper)
├─ transcriptFile.ts   (unchanged)
├─ parser.ts           (UsageSummary types internalized; per-call iteration helper added)
├─ traceRegistry.ts    (ID format updated to 32-hex trace IDs + 16-hex span IDs)
└─ utils.ts            (unchanged)
```

### Dependency changes

Remove: `weave`.

Add:
- `@opentelemetry/api`
- `@opentelemetry/sdk-trace-node`
- `@opentelemetry/sdk-trace-base`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`
- `@opentelemetry/exporter-trace-otlp-proto`

### Daemon startup

```ts
const resource = new Resource({
  'service.name': 'claude-code',
  'service.version': PLUGIN_VERSION,
  'wandb.entity': entity,
  'wandb.project': project,
});

const exporter = new OTLPTraceExporter({
  url: `${baseUrl}/agents/otel/v1/traces`,
  headers: { 'wandb-api-key': apiKey },
});

const provider = new NodeTracerProvider({ resource });
provider.addSpanProcessor(new BatchSpanProcessor(exporter));
provider.register();

const tracer = provider.getTracer('weave-claude-plugin', PLUGIN_VERSION);
```

Shutdown: `await provider.shutdown()` (flushes the BatchSpanProcessor).

### Trace ID continuity / resume

- OTel default `IdGenerator` produces random 32-hex trace IDs and 16-hex span IDs.
- `traceRegistry` stores `{sessionId, traceId, sessionSpanId, transcriptPath, source}`.
- On `SessionStart` with `source: "resume"`, look up the prior `traceId` from the registry. Force the new session span's `traceId` by passing a synthetic parent `SpanContext` (via `trace.setSpanContext` + `trace.wrapSpanContext`) carrying the prior trace ID and the prior session-span ID as parent. The new session span becomes a continuation in the same trace.
- On fresh `SessionStart`, let OTel generate fresh IDs.
- `WEAVE_TRACE_ID` / `WEAVE_PARENT_CALL_ID` env vars from a parent Claude Code process are honored the same way: synthetic parent context.

### State per session

```ts
interface SessionState {
  sessionId: string;
  transcript: TranscriptFile;
  cwd: string;

  sessionSpan?: Span;
  currentTurnSpan?: Span;

  turnNumber: number;
  totalToolCalls: number;
  turnToolCalls: number;
  toolCounts: Record<string, number>;
  totalUsage: Record<string, UsageSummary>;  // for SessionEnd summary

  pendingToolCalls: Map<string, PendingToolCall>;  // tool_use_id -> state
  subagentTrackers: Map<string, SubagentTracker>;
  subagentByAgentId: Map<string, SubagentTracker>;
}

interface PendingToolCall {
  span: Span;
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionStartedAt?: Date;
}

interface SubagentTracker {
  toolUseId: string;
  subagentType: string;
  detectedAt: Date;
  span?: Span;
  agentId?: string;
}
```

The `pendingToolCalls` and `subagentTrackers` maps consolidate into per-session storage; spans carry their own context, so we no longer need to store separate Weave call IDs / parent IDs.

## Data flow per hook

| Hook | Action |
|---|---|
| `SessionStart` | Create `SessionState`. Open session-level `invoke_agent claude-code` span (force prior `traceId` on resume). Store in registry. |
| `UserPromptSubmit` | Open turn-level `invoke_agent claude-code` span as child of session span. Set `gen_ai.input.messages` to `[{role:"user", content:prompt}]`. Increment `turnNumber`. |
| `PreToolUse` | Open `execute_tool <name>` span as child of turn span (or subagent span if `agent_id` set). Record tool input. If `Agent` tool with `subagent_type`, create a `SubagentTracker`. |
| `PermissionRequest` | Record `permissionStartedAt` and `permissionSuggestions` on the `PendingToolCall`. (Event is added at `PostToolUse[Failure]` once the outcome is known — OTel events are immutable so we defer until we have `approved`.) |
| `PostToolUse` | If a permission was recorded, emit `weave.permission_request` event on the tool span with `weave.permission.approved=true`, `weave.permission.suggestions`, timestamp=`permissionStartedAt`. Set `gen_ai.tool.call.result` from `tool_response`. Close tool span. |
| `PostToolUseFailure` | If a permission was recorded, emit `weave.permission_request` event with `weave.permission.approved=false`, timestamp=`permissionStartedAt`. Set `error.type`, span status `ERROR`. Close tool span. |
| `SubagentStart` | Match closest unmatched `SubagentTracker` by temporal proximity. Open `invoke_agent <subagent_type>` span as child of turn span (NOT the tool span). Record `gen_ai.agent.id`, `gen_ai.conversation.id`, and `weave.claude_code.subagent.spawning_tool_call_id`. |
| `SubagentStop` | Parse subagent transcript for model. Set `gen_ai.output.messages` to `last_assistant_message`. Close subagent span. |
| `PreCompact` | Add `weave.compaction` event on session span. |
| `Stop` | Parse transcript for the current turn. For each assistant message, emit a `chat <model>` span as child of turn span with backdated timestamps and per-call usage. Aggregate finish_reason and final-text into turn span. Close turn span. |
| `SessionEnd` | Close any orphaned tool/subagent spans with ERROR status. Aggregate counts onto session span. Close session span. Update registry. |

## Error handling

- **OTel exporter failures**: `BatchSpanProcessor` handles retries internally. Failures logged via OTel diagnostic logger; daemon logs at INFO when exporter init fails. Plugin continues to receive hook events; spans are dropped silently if export fails. No backpressure into the hook handler — match today's behavior.
- **Missing transcript**: Stop hook proceeds with hook-payload `last_assistant_message` only; no chat spans emitted. Logged at DEBUG.
- **Daemon crash mid-session**: Spans not yet ended are lost. Acceptable — same risk profile as today. Registry preserves traceId for resume.
- **Orphan tool/subagent spans at SessionEnd**: Closed with span status `ERROR` and `weave.claude_code.orphan_reason` attribute.

## Testing

- **Local build**: `npm run build` passes (`tsc`).
- **Local smoke test**: Run the daemon against a local `weave-trace` instance, observe spans land in the `agents/spans/query` endpoint with correct attributes.
- **Manual ID-format check**: After SessionStart, inspect a span via the local agents query endpoint and verify `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.conversation.id` are present.
- **Resume continuity**: Start a session, kill the daemon mid-turn, resume. Verify the resumed turn's traceId matches the original.

## Out of scope

- PII scrubbing / redaction (still planned for a future release per current README).
- Migration tooling for prior traces on the call/start API — they remain in the call backend, not migrated to the agents backend.
- Metrics emission. Spans only.
- Dual-emit during migration. Hard cut-over per decision #1.
