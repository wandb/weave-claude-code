// Verify the trace registry records one entry per turn at handleStop, that
// `recentTurns(N)` returns them, that `turnsForSession(id)` filters
// correctly, and that `findByTracePrefix(prefix)` resolves partial trace ids.
//
// We point CONFIG_DIR at a tmp directory by overriding HOME for the
// duration of the test — the registry module computes its file path from
// `os.homedir()` via setup.ts:CONFIG_DIR, so flipping HOME is the
// lightest-touch isolation.

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

// HOME must be redirected BEFORE we import anything that reads CONFIG_DIR.
const realHome = homedir();
const fakeHome = mkdtempSync(join(tmpdir(), 'wcp-registry-test-'));
process.env.HOME = fakeHome;

const distUrl = (rel) => new URL(`../../dist/${rel}`, import.meta.url).href;
const { GlobalDaemon } = await import(distUrl('daemon.js'));
const { recentTurns, turnsForSession, findByTracePrefix, REGISTRY_FILE } = await import(distUrl('traceRegistry.js'));

// Confirm the registry path is inside the fake home, not the user's real one.
if (!REGISTRY_FILE.startsWith(fakeHome)) {
  console.error(`FAIL: REGISTRY_FILE=${REGISTRY_FILE} not under fakeHome=${fakeHome} — would clobber the real registry. Aborting.`);
  process.exit(1);
}

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'claude-code', 'service.version': 'test' }),
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

const sessionA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const sessionB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Tiny parent transcripts so SessionStart doesn't fail.
const projDir = join(fakeHome, '.claude/projects/-tmp-registry');
mkdirSync(projDir, { recursive: true });
const aPath = join(projDir, `${sessionA}.jsonl`);
const bPath = join(projDir, `${sessionB}.jsonl`);
writeFileSync(aPath, JSON.stringify({ type: 'summary', sessionId: sessionA }) + '\n');
writeFileSync(bPath, JSON.stringify({ type: 'summary', sessionId: sessionB }) + '\n');

const daemon = new GlobalDaemon('/tmp/unused.sock', join(tmpdir(), 'registry-test.log'), 'me/proj', 'unused', 'http://unused', false);
daemon.tracer = provider.getTracer('weave-claude-plugin', 'test');
daemon.provider = provider;

// Drive 2 turns for session A and 1 turn for session B.
async function runTurn(sessionId, transcriptPath) {
  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcriptPath, source: 'startup', cwd: '/tmp/example-cwd' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'p' });
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: 'done' });
}

await runTurn(sessionA, aPath);
await runTurn(sessionA, aPath);
await runTurn(sessionB, bPath);
await provider.forceFlush();

// --- Assertions ---
let fails = 0;
const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) fails++; };

// 1. Registry file exists.
check('registry file written', existsSync(REGISTRY_FILE));

// 2. recentTurns returns 3 entries, newest last.
const rec = recentTurns(10);
check('recentTurns(10) returns 3 entries', rec.length === 3);

// 3. Each entry has a non-empty 32-char trace id.
check('every entry has 32-char trace id', rec.every(t => /^[0-9a-f]{32}$/i.test(t.traceId)));

// 4. recentTurns(2) returns just the last 2.
const last2 = recentTurns(2);
check('recentTurns(2) returns last 2', last2.length === 2 && last2[0].traceId === rec[1].traceId && last2[1].traceId === rec[2].traceId);

// 5. turnsForSession(A) returns 2; for B returns 1.
const aTurns = turnsForSession(sessionA);
const bTurns = turnsForSession(sessionB);
check('session A has 2 turns', aTurns.length === 2);
check('session B has 1 turn', bTurns.length === 1);

// 6. findByTracePrefix using the first 8 hex of an entry resolves to it.
const target = rec[1];
const found = findByTracePrefix(target.traceId.slice(0, 8));
check('findByTracePrefix(8-char prefix) returns matching entry', found?.traceId === target.traceId);

// 7. findByTracePrefix with a non-matching prefix returns undefined.
check('findByTracePrefix(zzz) returns undefined', findByTracePrefix('zzzzzzzz') === undefined);

// 8. cwd is captured.
check('cwd captured on every entry', rec.every(t => t.cwd === '/tmp/example-cwd'));

// 9. File is valid JSON with the expected schema version.
const file = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
check('registry schema version >= 3', file.version >= 3);
check('registry entries is an array', Array.isArray(file.entries));

// Cleanup
process.env.HOME = realHome;
rmSync(fakeHome, { recursive: true, force: true });

console.log(`\n${rec.length} turns recorded; ${fails === 0 ? 'all checks passed' : `${fails} failures`}`);
process.exit(fails === 0 ? 0 : 1);
