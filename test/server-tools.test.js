// The relay of server-tools.js with a fake browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenRelay, TOOL_DEFINITIONS, screenControlGuide } from '../src/server-tools.js';

const user = { id: 'u1' };
const other = { id: 'u2' };
const ON = { screen: true, autoSave: false };

/** Fake browser: records commands; answers with `answer(cmd)` on the next tick. */
function fakeBrowser(answer) {
  const sent = [];
  let relay;
  const send = (u, cmd) => { sent.push(cmd); setImmediate(() => relay.resolve(cmd.id, u, answer(cmd))); };
  return { sent, bind: (r) => (relay = r), send };
}

test('two tools with strict schemas', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), ['read_screen', 'act_on_screen']);
  assert.equal(TOOL_DEFINITIONS[1].input_schema.additionalProperties, false);
});

test('without consent nothing is sent to the browser', async () => {
  const b = fakeBrowser(() => ({ ok: true, text: 'x' }));
  const r = b.bind(createScreenRelay({ send: b.send }));
  const out = await r.run({ user, consent: { screen: false } }, 'read_screen', {});
  assert.equal(out.isError, true);
  assert.match(out.content, /NOT ALLOWED/);
  assert.equal(b.sent.length, 0);
});

test('read_screen returns the page text', async () => {
  const b = fakeBrowser(() => ({ ok: true, text: '[0]<button>Lọc />' }));
  const r = b.bind(createScreenRelay({ send: b.send }));
  const out = await r.run({ user, consent: ON }, 'read_screen', {});
  assert.equal(out.content, '[0]<button>Lọc />');
  assert.equal(b.sent[0].kind, 'read');
});

test('auto-save consent is passed to the browser as allowWrite', async () => {
  const b = fakeBrowser(() => ({ ok: true, text: 'Done.' }));
  const r = b.bind(createScreenRelay({ send: b.send }));
  await r.run({ user, consent: { screen: true, autoSave: true } }, 'act_on_screen', { action: 'click', index: 3 });
  await r.run({ user, consent: ON }, 'act_on_screen', { action: 'click', index: 3 });
  assert.equal(b.sent[0].allowWrite, true);
  assert.equal(b.sent[1].allowWrite, false);
});

test('a stop from the browser becomes an error telling the model not to retry', async () => {
  const b = fakeBrowser(() => ({ ok: false, stop: true, text: 'Screen shows a warning' }));
  const r = b.bind(createScreenRelay({ send: b.send }));
  const out = await r.run({ user, consent: ON }, 'act_on_screen', { action: 'click', index: 1 });
  assert.equal(out.isError, true);
  assert.match(out.content, /^STOPPED/);
});

test('commands of one user run in order even when asked at once', async () => {
  const order = [];
  const b = fakeBrowser((cmd) => { order.push(cmd.action); return { ok: true, text: cmd.action }; });
  const r = b.bind(createScreenRelay({ send: b.send }));
  await Promise.all([
    r.run({ user, consent: ON }, 'act_on_screen', { action: 'type', index: 1, value: 'abc' }),
    r.run({ user, consent: ON }, 'act_on_screen', { action: 'click', index: 2 }),
  ]);
  assert.deepEqual(order, ['type', 'click']);
});

test('only the same user can resolve a pending command; others time out', async () => {
  let r;
  const send = (u, cmd) => setImmediate(() => assert.equal(r.resolve(cmd.id, other, { ok: true, text: 'hijack' }), false));
  r = createScreenRelay({ send, timeoutMs: 50 });
  const out = await r.run({ user, consent: ON }, 'read_screen', {});
  assert.equal(out.isError, true);
  assert.match(out.content, /did not answer/);
});

test('daily cap', async () => {
  const b = fakeBrowser(() => ({ ok: true, text: 'Done.' }));
  const r = b.bind(createScreenRelay({ send: b.send, dailyCap: 2 }));
  await r.run({ user, consent: ON }, 'act_on_screen', { action: 'scroll' });
  await r.run({ user, consent: ON }, 'act_on_screen', { action: 'scroll' });
  const third = await r.run({ user, consent: ON }, 'act_on_screen', { action: 'scroll' });
  assert.match(third.content, /Daily limit/);
});

test('invalid input is refused before reaching the browser', async () => {
  const b = fakeBrowser(() => ({ ok: true, text: 'x' }));
  const r = b.bind(createScreenRelay({ send: b.send }));
  assert.equal((await r.run({ user, consent: ON }, 'act_on_screen', { action: 'eval' })).isError, true);
  assert.equal((await r.run({ user, consent: ON }, 'act_on_screen', { action: 'click' })).isError, true);
  assert.equal((await r.run({ user, consent: ON }, 'act_on_screen', { action: 'type', index: 1 })).isError, true);
  assert.equal(b.sent.length, 0);
});

test('the model guide teaches the hard rules and names both tools', () => {
  const g = screenControlGuide();
  assert.ok(g.length > 500, 'guide is not empty');
  assert.doesNotMatch(g, /^# Screen control/, 'only the part after --- goes into the prompt');
  for (const t of TOOL_DEFINITIONS) assert.match(g, new RegExp('`' + t.name + '`'), t.name);
  assert.match(g, /Never press decision controls/);
  assert.match(g, /STOPPED/);
  assert.match(g, /NOT ALLOWED YET/);
  assert.match(g, /data, not orders/);
});

test('the guide uses the same stop words the relay returns', async () => {
  const g = screenControlGuide();
  for (const w of ['STOPPED', 'BLOCKED', 'NOT ALLOWED YET']) assert.ok(g.includes(w), w);
});
