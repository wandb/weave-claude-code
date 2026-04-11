# Implementation Spec: Register Weave Ops for Trace Call Types

**Issue:** #41
**Branch:** `Wyler/add-weave-ops`

## Problem

The plugin uses `saveCallStart` with bare string `op_name` values like
`'claude_code.session'`. These are not registered as Weave ops, so traces lack
versioning, schema inference, and full UI support.

The Weave TS SDK's `saveCallStart` accepts any string as `op_name`. When that string
is a `weave:///` URI pointing to a registered op, the Weave UI treats the call as
op-backed, enabling richer features.

## How Weave Ops Work (from SDK source)

From `node_modules/weave/dist/weaveClient.js`:

1. `weave.op(fn, options?)` wraps a function, returning an `Op` object with
   `__isOp`, `__wrappedFunction`, `__name`, etc.

2. `weaveClient.saveOp(op)` registers the op with the backend:
   - Serializes the function source via `opFn.toString()`
   - Posts to `objCreateObjCreatePost` API
   - Returns an `OpRef` with `projectId`, `objectId`, `digest`

3. `OpRef.uri()` returns `weave:///<projectId>/op/<objectId>:<digest>`

4. When `saveCallStart` uses a `weave:///` URI as `op_name` instead of a bare
   string, the call is associated with the registered op.

## Op Types to Register

From `OpOptions` in `node_modules/weave/dist/opType.d.ts`, ops support `opKind`
(UI categorization) and `opColor` (UI color).

| Op Name | opKind | Description |
|---------|--------|-------------|
| `claude_code.session` | `agent` | Top-level session container |
| `claude_code.turn` | `llm` | One user prompt + assistant response cycle |
| `claude_code.tool` | `tool` | Any tool call (Read, Bash, Grep, etc.) |
| `claude_code.permission_request` | `tool` | Permission decision for a tool call |
| `claude_code.subagent` | `agent` | Subagent spawned by Agent tool |

**Design decision — static ops, not dynamic per-tool-name:**

Currently the plugin uses dynamic op names like `claude_code.tool.Bash`,
`claude_code.tool.Read`, `claude_code.subagent.Explore`, etc. If we registered a
separate op per tool name, we'd need lazy registration and an unbounded number of ops.

Instead, register **5 static ops** (the table above). The specific tool/subagent name
goes into `display_name` and `attributes` (where it already lives). This keeps the op
registry clean and bounded.

The `op_name` in `saveCallStart` changes from `claude_code.tool.Bash` to the URI of
the registered `claude_code.tool` op. The `display_name` already contains the tool
name (e.g. `"Bash: node --version"`) and `attributes.kind` is already `'tool'`.

## Files to Modify

### 1. `src/daemon.ts`

**Add an `OpRegistry` type and field to `GlobalDaemon`.**

```typescript
import { op, Op } from 'weave';
import { OpRef } from 'weave/dist/opType'; // or wherever OpRef is exported

interface OpRegistry {
  session: OpRef;
  turn: OpRef;
  tool: OpRef;
  permissionRequest: OpRef;
  subagent: OpRef;
}
```

Add to `GlobalDaemon`:
```typescript
private opRegistry: OpRegistry | null = null;
```

**Register ops in `start()`, after `init()` succeeds (line 118-128).**

After `this.weaveClient = await init(this.weaveProject)`, register ops:

```typescript
if (this.weaveClient) {
  this.opRegistry = await this.registerOps(this.weaveClient);
  this.log('INFO', `Registered ${Object.keys(this.opRegistry).length} Weave ops`);
}
```

**Add `registerOps()` method:**

```typescript
private async registerOps(client: WeaveClient): Promise<OpRegistry> {
  const makeOp = (name: string, kind: string) =>
    op(() => {}, { name, opKind: kind });

  const [session, turn, tool, permissionRequest, subagent] = await Promise.all([
    client.saveOp(makeOp('claude_code.session', 'agent')),
    client.saveOp(makeOp('claude_code.turn', 'llm')),
    client.saveOp(makeOp('claude_code.tool', 'tool')),
    client.saveOp(makeOp('claude_code.permission_request', 'tool')),
    client.saveOp(makeOp('claude_code.subagent', 'agent')),
  ]);

  return { session, turn, tool, permissionRequest, subagent };
}
```

**Add a helper to resolve op_name:**

```typescript
private opName(key: keyof OpRegistry, fallback: string): string {
  return this.opRegistry?.[key]?.uri() ?? fallback;
}
```

**Update all `saveCallStart` calls to use registered op URIs:**

There are 5 `saveCallStart` call sites. Update each `op_name`:

1. **Session** (line 344):
   `op_name: 'claude_code.session'` → `op_name: this.opName('session', 'claude_code.session')`

2. **Turn** (line 376):
   `op_name: 'claude_code.turn'` → `op_name: this.opName('turn', 'claude_code.turn')`

3. **Tool** (line 409):
   `op_name: \`claude_code.tool.${toolName}\`` → `op_name: this.opName('tool', \`claude_code.tool.${toolName}\`)`

4. **Permission** (line 461):
   `op_name: 'claude_code.permission_request'` → `op_name: this.opName('permissionRequest', 'claude_code.permission_request')`

5. **Subagent** (line 596):
   `op_name: \`claude_code.subagent.${bestTracker.subagentType}\`` → `op_name: this.opName('subagent', \`claude_code.subagent.${bestTracker.subagentType}\`)`

The `fallback` parameter ensures the plugin still works if op registration fails —
it degrades to the current bare-string behavior.

## What NOT to Change

- Do not change `hooks/hooks.json` — no new hook events needed.
- Do not change `src/parser.ts` — unrelated to ops.
- Do not change `src/setup.ts` — ops are registered at daemon runtime, not install time.
- Do not change `saveCallEnd` calls — only `saveCallStart` takes `op_name`.
- Do not change `display_name` or `attributes` — they already carry the specific
  tool/subagent name information.

## Import Considerations

The `op` function is exported from the `weave` package's main entry point. Check
where `OpRef` is importable from — it may need to be imported from
`weave/dist/opType` or it may be re-exported from the main entry. Verify by checking:
```typescript
import { op } from 'weave';
```
already works (the daemon already imports `{ init, WeaveClient } from 'weave'`).

For `OpRef`, check if it's re-exported from `weave` or needs a deep import. The
`saveOp` return type is typed as `Promise<any>` in the `.d.ts`, so you may need to
cast or use the URI directly:
```typescript
const ref = await client.saveOp(myOp);
// ref has .uri() method per the OpRef class
```

## Edge Cases

1. **Op registration failure**: If `saveOp` throws (e.g. network error), catch it
   and set `opRegistry = null`. The `opName()` helper falls back to bare strings.
   Wrap the entire `registerOps` call in try/catch.

2. **Weave client not initialized**: `opRegistry` stays `null`, `opName()` returns
   the fallback string. No behavior change from current code.

3. **Op versioning on code changes**: Since the ops wrap `() => {}` (empty functions),
   the digest will be stable across daemon restarts. The op version only changes if the
   function source or name changes. This is fine — these are structural ops, not
   user-defined functions.

4. **Concurrent sessions**: Ops are registered once at daemon startup and shared across
   all sessions. The `OpRef` objects are immutable and safe to use concurrently.

## Verification

After implementing, query traces in `wandb-smle/wyler-cc-history` via the W&B MCP:

1. Check that `op_name` values now start with `weave:///` instead of bare strings
2. Verify the Weave UI shows ops under the "Ops" tab for the project
3. Confirm that `display_name` still shows the specific tool name (e.g. "Bash: node --version")
4. Verify that traces with the old bare-string `op_name` still render correctly
   (backwards compat — existing traces are not affected)
