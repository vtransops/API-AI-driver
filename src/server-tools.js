/**
 * server-tools.js — the server half: two tools for the model and a relay that runs them on the user's screen.
 * Works with any client that runs screen-agent.js: a web page, a desktop app, a mobile app.
 *
 *   read_screen     → the screen as numbered text
 *   act_on_screen   → click / type / select / scroll by number
 *
 * The command runs on the CLIENT of the person who is asking, inside their own login session and with their own
 * permissions. The server holds no special rights for the assistant. Flow:
 *
 *   model asks for a tool → relay.run() → send({ id, ...command }) to that user's client (SSE / WebSocket / IPC)
 *   → client runs screen-agent → sends the result back → relay.resolve(id, user, result) → tool result to the model
 *
 * Rules enforced here, whatever the model asks:
 *   - the user must have ticked "screen control" (consent.screen); write buttons need consent.autoSave too;
 *   - commands for one user run strictly in order (type, THEN click), even when the model asks for several at once;
 *   - only the same user can resolve a pending command; unanswered commands time out;
 *   - a daily cap per user;
 *   - a result with `stop` becomes an error that tells the model to stop and report, not retry.
 */

import { randomBytes } from 'node:crypto';

export const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'read_screen',
    description: 'Read the screen the user has open (a web page or an app window). Returns its text; every element that can be clicked or typed into carries a number like [12]. Use before acting and again after a few actions to see what changed. Only when the user has turned on screen control and asked clearly.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  }),
  Object.freeze({
    name: 'act_on_screen',
    description: 'Act on the user\'s screen by element NUMBER from the latest read_screen: click, type (text into a field), select (an option), scroll. Decision, send, payment, order and delete controls are blocked. Save buttons work only when the user has turned on auto-save. If the screen shows an error or a warning the tool returns STOPPED: tell the user exactly what it says and do not try another way.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'select', 'scroll'] },
        index: { type: 'integer', minimum: 0, description: 'Element number (required for click / type / select)' },
        value: { type: 'string', description: 'Text to type, or the option to select' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default down)' },
      },
    },
  }),
]);

const STOP_WORDS = /STOPPED|BLOCKED|NOT ALLOWED/;

/**
 * @param {object} opts
 * @param {(user: {id: string}, command: object) => void} opts.send   push a command to that user's open page
 * @param {number} [opts.timeoutMs=25000]
 * @param {number} [opts.dailyCap=300]
 * @param {() => Date} [opts.now]
 */
export function createScreenRelay({ send, timeoutMs = 25000, dailyCap = 300, now = () => new Date() } = {}) {
  if (typeof send !== 'function') throw new TypeError('send is required');
  const pending = new Map();   // id → { userId, resolve, timer }
  const queues = new Map();    // userId → tail promise
  const counts = new Map();    // userId:day → number of actions

  const day = () => now().toISOString().slice(0, 10);

  function callBrowser(user, command) {
    return new Promise((resolve) => {
      const id = randomBytes(9).toString('hex');
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, text: 'The screen did not answer in time (panel closed or connection lost).' });
      }, timeoutMs);
      pending.set(id, { userId: user.id, resolve, timer });
      try { send(user, { id, ...command }); } catch {
        clearTimeout(timer); pending.delete(id);
        resolve({ ok: false, text: 'Could not send the command to the screen.' });
      }
    });
  }

  async function runNow({ user, consent }, toolName, input) {
    if (!user || !user.id) return { content: 'No user.', isError: true };
    if (!consent || !consent.screen) {
      return { content: 'NOT ALLOWED: the user has not turned on screen control. Tell them where to turn it on; do not try another way.', isError: true };
    }
    let command;
    if (toolName === 'read_screen') command = { kind: 'read' };
    else if (toolName === 'act_on_screen') {
      const a = input && input.action;
      if (!['click', 'type', 'select', 'scroll'].includes(a)) return { content: 'Unknown action.', isError: true };
      const i = input.index;
      if (a !== 'scroll' && !(Number.isInteger(i) && i >= 0)) return { content: 'Missing element number (index).', isError: true };
      if ((a === 'type' || a === 'select') && typeof input.value !== 'string') return { content: 'Missing value.', isError: true };
      const key = user.id + ':' + day();
      const n = (counts.get(key) || 0) + 1;
      if (n > dailyCap) return { content: 'Daily limit of screen actions reached (' + dailyCap + ').', isError: true };
      counts.set(key, n);
      command = {
        kind: 'act', action: a, index: Number.isInteger(i) ? i : null,
        value: typeof input.value === 'string' ? input.value.slice(0, 2000) : '',
        direction: input.direction === 'up' ? 'up' : 'down',
        allowWrite: !!consent.autoSave,
      };
    } else return { content: 'No tool named ' + toolName + '.', isError: true };

    const r = await callBrowser(user, command);
    const text = String(r && r.text != null ? r.text : '').slice(0, 12000);
    if (r && r.stop) return { content: STOP_WORDS.test(text) ? text : 'STOPPED: ' + text + '. Report it to the user; do not retry.', isError: true };
    if (r && r.ok === false) return { content: text || 'Not done.', isError: true };
    return { content: text };
  }

  /** Run a tool. Commands of one user are queued so they execute in the order the model asked for them. */
  function run(ctx, toolName, input) {
    const k = ctx && ctx.user ? String(ctx.user.id) : '?';
    const prev = queues.get(k) || Promise.resolve();
    const next = prev.then(() => runNow(ctx, toolName, input));
    const tail = next.catch(() => {});
    queues.set(k, tail);
    tail.then(() => { if (queues.get(k) === tail) queues.delete(k); });
    return next;
  }

  /** The browser posts a result. Only the user the command was sent to can resolve it. */
  function resolve(id, user, result) {
    const p = pending.get(id);
    if (!p || !user || p.userId !== user.id) return false;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(result && typeof result === 'object' ? result : { ok: false, text: 'Malformed result from the browser.' });
    return true;
  }

  return { run, resolve, _pending: pending };
}
