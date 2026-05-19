// Verify the parser treats *only typed user prompts* (bare-string content) as
// turn boundaries — and does NOT split on mid-turn user-text injections
// (skill content, command-message envelopes, system reminders, interrupts).
//
// Each case below is a tiny synthesized transcript. The assertion is that
// the parser produces the expected number of turns and that the LAST turn
// contains the assistant's synthesis text.

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, openSync, closeSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const parserPath = join(__dirname, '..', '..', 'dist', 'parser.js');
const { parseSessionFd } = await import(parserPath);

const tmp = mkdtempSync(join(tmpdir(), 'parser-boundary-'));

function write(name, lines) {
  const path = join(tmp, name);
  writeFileSync(path, lines.map(JSON.stringify).join('\n') + '\n');
  return path;
}
function parse(path) {
  const fd = openSync(path, 'r');
  try { return parseSessionFd(fd); }
  finally { closeSync(fd); }
}

// Building blocks
const userPrompt = (text, t) => ({
  type: 'user', message: { role: 'user', content: text }, timestamp: t,
});
const userTextInjection = (text, t) => ({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: t,
});
const userToolResult = (toolUseId, t) => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }, timestamp: t,
});
const assistantText = (text, model, t) => ({
  type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text }] }, timestamp: t,
});
const assistantToolUse = (name, id, model, t) => ({
  type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', name, id, input: {} }] }, timestamp: t,
});

const cases = [];

cases.push({
  name: 'baseline: one typed prompt, one assistant text → 1 turn',
  lines: [
    userPrompt('hi', '00'),
    assistantText('hello', 'm', '01'),
  ],
  expectTurns: 1,
  expectLastSynthesis: 'hello',
});

cases.push({
  name: 'two typed prompts (welcome + real) → 2 turns',
  lines: [
    userPrompt('hi', '00'),
    assistantText('hello', 'm', '01'),
    userPrompt('do X', '02'),
    assistantText('result', 'm', '03'),
  ],
  expectTurns: 2,
  expectLastSynthesis: 'result',
});

cases.push({
  name: 'skill-content user-text mid-turn does NOT split',
  lines: [
    userPrompt('/skill arg', '00'),
    userTextInjection('Base directory for this skill: /path/skill\n# skill body content\n...', '00.5'),
    assistantText('I will do the thing', 'm', '01'),
    assistantToolUse('Bash', 't1', 'm', '02'),
    userToolResult('t1', '03'),
    assistantText('FINAL synthesis', 'm', '04'),
  ],
  expectTurns: 1,
  expectLastSynthesis: 'FINAL synthesis',
});

cases.push({
  name: 'user-interrupt mid-Agent does NOT split (the 0.6% case)',
  lines: [
    userPrompt('do the explore', '00'),
    assistantText('Dispatching subagent.', 'm', '01'),
    assistantToolUse('Agent', 'tA', 'm', '02'),
    userTextInjection('[Request interrupted by user for tool use]', '03'),
    assistantText('Recovered. Here is the answer.', 'm', '04'),
  ],
  expectTurns: 1,
  expectLastSynthesis: 'Recovered. Here is the answer.',
});

cases.push({
  name: 'command-message envelope user-text does NOT split',
  lines: [
    userPrompt('/talk-to-tim ask Tim something', '00'),
    userTextInjection('<command-message>talk-to-tim</command-message>\n<command-args>ask Tim something</command-args>', '00.5'),
    assistantText('Spawning Tim now.', 'm', '01'),
    assistantToolUse('Agent', 'tA', 'm', '02'),
    userToolResult('tA', '03'),
    assistantText("Here is Tim's response.", 'm', '04'),
  ],
  expectTurns: 1,
  expectLastSynthesis: "Here is Tim's response.",
});

cases.push({
  name: 'multiple injections in same turn still 1 turn',
  lines: [
    userPrompt('go', '00'),
    userTextInjection('skill body', '00.5'),
    assistantText('working', 'm', '01'),
    userTextInjection('system reminder ABC', '01.5'),
    assistantToolUse('Read', 'tR', 'm', '02'),
    userToolResult('tR', '03'),
    userTextInjection('another reminder', '03.5'),
    assistantText('done', 'm', '04'),
  ],
  expectTurns: 1,
  expectLastSynthesis: 'done',
});

cases.push({
  name: 'subagent transcript pre-context line still gives 2 turns',
  // Mimics what `prompt_suggestion` / `compact` built-ins produce:
  //   line 0: assistant (parent's prior message carried in as pre-context)
  //   line 1: user (typed prompt — bare string)
  //   line 2+: subagent's own assistant work
  // Should remain 2 turns (pre-context + subagent work), matching prior behavior.
  lines: [
    assistantText('parent prior message', 'm-parent', '00'),
    userPrompt('subagent task prompt', '01'),
    assistantText('subagent reply', 'm-sub', '02'),
  ],
  expectTurns: 2,
  expectLastSynthesis: 'subagent reply',
});

let pass = 0, fail = 0;
for (const c of cases) {
  const path = write(`${c.name.replace(/[^a-z0-9]+/gi, '-')}.jsonl`, c.lines);
  const parsed = parse(path);
  const turns = parsed?.turns ?? [];
  const lastTurn = turns[turns.length - 1];
  const lastSynth = lastTurn?.textBlocks().slice(-1)[0] ?? '';

  const turnsOk = turns.length === c.expectTurns;
  const synthOk = !c.expectLastSynthesis || lastSynth === c.expectLastSynthesis;
  if (turnsOk && synthOk) {
    console.log(`PASS  ${c.name}`);
    pass++;
  } else {
    console.log(`FAIL  ${c.name}`);
    console.log(`  expected turns=${c.expectTurns}, got ${turns.length}`);
    console.log(`  expected last synth=${JSON.stringify(c.expectLastSynthesis)}, got ${JSON.stringify(lastSynth)}`);
    fail++;
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
