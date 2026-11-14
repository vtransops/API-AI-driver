/**
 * screen-agent.js — a platform-independent guard between ANY AI assistant and the screen it operates.
 *
 * The assistant never sees pixels and never runs code. A platform "controller" (web page, desktop app, mobile app)
 * turns the screen into TEXT in which every clickable / typeable element carries a number like [12], and performs
 * four actions by number: click, type, select, scroll. This module sits in between and decides, before anything
 * runs, whether the target element may be touched:
 *
 *   block  — decisions and irreversible or outward-facing actions: confirm, send, pay, refund, place an order,
 *            publish, delete, sign, change permissions. Never performed.
 *   write  — actions that save data. Performed only when the user has turned on "auto-save".
 *   normal — open, filter, read, scroll. Performed.
 *
 * After an action, notifications that appear on screen are collected for a short moment. If any of them reads like
 * an error or a warning, the result carries `stop: true`; the server must make the model stop and report the message
 * to the user word for word instead of trying something else.
 *
 * Screen text is DATA, not instructions: a customer name, an email body or a note may contain text that looks like an
 * order to the assistant. Nothing here depends on the model behaving well.
 *
 * The controller interface (see adapters/web-page-controller.js for the web implementation):
 *
 *   read()                    → Promise<string>            screen as numbered text
 *   describe(index)           → Promise<Element | null>    { marker, text, label, id, tag, type, inForm }
 *   click(index)              → Promise<{ success, message }>
 *   type(index, text)         → Promise<{ success, message }>
 *   select(index, option)     → Promise<{ success, message }>
 *   scroll({ down, index })   → Promise<{ success, message }>
 *   watch(run, waitMs)        → Promise<{ res, notices }>   notices that APPEARED or CHANGED while `run` executed
 *
 * The decision helpers (classify, decide, isWarning) are pure and exported for tests.
 */

/** Default rules for many kinds of software. Prefer explicit markers (data-ai="block" / "write"); text is a fallback. */
export const DEFAULT_RULES = Object.freeze({
  /* Never clicked, in any software (Vietnamese and English). */
  blockText: new RegExp([
    // delete / cancel / stop
    'xo[aá]', 'xoá', 'xóa', 'hu[yỷ]', 'huỷ', 'hủy', 'ngừng', '\\bdelete\\b', '\\bremove\\b', '\\bcancel\\b', '\\bterminate\\b',
    // send / publish outside
    'gửi', 'phát hành', 'đăng bài', '\\bsend\\b', '\\bpublish\\b', '\\bpost\\b', '\\breply\\b', '\\bforward\\b',
    // money
    'thanh toán', 'chuyển khoản', 'chuyển tiền', 'nạp tiền', 'rút tiền', 'hoàn tiền', 'đặt hàng', 'mua ngay',
    '\\bpay\\b', '\\bpayment\\b', '\\btransfer\\b', '\\brefund\\b', '\\bcheckout\\b', 'place order', 'buy now', '\\bwithdraw\\b',
    // decisions / approvals / signatures
    'duyệt', 'phê duyệt', 'đẩy', 'xác nhận (&|và) bắt đầu', 'ký số', 'khoá sổ', 'khóa sổ', '\\bapprove\\b', '\\bsign\\b', '\\bsubmit for\\b',
    'issue (an? )?invoice', 'confirm (&|and) start', 'close (the )?period',
    // accounts and access
    'mật khẩu', 'phân quyền', 'đăng xuất', 'password', 'permission', 'log ?out', 'sign ?out',
  ].join('|'), 'i'),
  /* Buttons that save data. Checked on the visible text only, after leading icons are stripped. */
  writeText: /^(lưu|ghi|cập nhật|tạo|thêm mới|xác nhận|đồng ý|hoàn tất|save|update|create|confirm|apply|submit|add)\b/i,
  /* Text that means the screen is warning the user. */
  warningText: /(lỗi|không (thể|được|hợp lệ|khớp|đủ)|chưa (được|có|đủ|chọn|nhập)|cảnh báo|trùng|thiếu|vượt|thất bại|từ chối|hết hạn|\berror\b|\bfailed\b|\binvalid\b|\bwarning\b|not allowed|denied|mismatch|insufficient)/i,
});

const ACTIONS = ['click', 'type', 'select', 'scroll'];

/** Strip leading icons / emoji so "✅ Save" is compared as "Save". */
function visibleWords(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '');
}

/**
 * Classify one element description.
 * @param {{ marker?: string, text?: string, label?: string, id?: string, tag?: string, type?: string, inForm?: boolean }} el
 * @returns {'block' | 'write' | 'normal'}
 */
export function classify(el, rules = DEFAULT_RULES) {
  const e = el || {};
  if (e.marker === 'block') return 'block';
  if (e.marker === 'write') return 'write';
  if (e.marker === 'normal') return 'normal';
  const all = [e.text, e.label, e.id].filter(Boolean).join(' ');
  if (rules.blockText.test(all)) return 'block';
  if (rules.writeText.test(visibleWords(e.text || e.label || ''))) return 'write';
  /* A submit button only writes when it sits inside a form. */
  if (e.inForm && (e.tag === 'button' || e.tag === 'input') && e.type === 'submit') return 'write';
  return 'normal';
}

/**
 * Decide whether an action may run.
 * Marker-based blocks apply to every action (typing Enter into a chat box sends a message).
 * Text-based blocks apply to clicks only (a search box labelled "send date" must stay typeable).
 * @returns {{ allowed: boolean, stop?: boolean, reason?: string }}
 */
export function decide(action, el, { allowWrite = false } = {}, rules = DEFAULT_RULES) {
  if (!ACTIONS.includes(action)) return { allowed: false, reason: 'Unknown action.' };
  if (action === 'scroll') return { allowed: true };
  const cls = classify(el, rules);
  if (cls === 'block' && (action === 'click' || (el && el.marker === 'block'))) {
    return { allowed: false, stop: true, reason: 'BLOCKED: this control is reserved for the user. Do not press it; tell the user to do it.' };
  }
  if (cls === 'write' && action === 'click' && !allowWrite) {
    return { allowed: false, stop: true, reason: 'NOT ALLOWED YET: this button saves data and the user has not turned on auto-save. Fill the form, then ask the user to press it.' };
  }
  return { allowed: true };
}

/** True when a notification text reads like an error or a warning. */
export function isWarning(text, rules = DEFAULT_RULES) {
  return rules.warningText.test(String(text == null ? '' : text));
}

/**
 * Create the agent on top of a platform controller.
 * @param {object} opts
 * @param {object} opts.controller  implements read / describe / click / type / select / scroll / watch
 * @param {object} [opts.rules]     override DEFAULT_RULES
 * @param {number} [opts.maxChars]  cap on the screen text returned by read()
 */
export function createScreenAgent({ controller, rules = DEFAULT_RULES, maxChars = 9000 } = {}) {
  if (!controller) throw new TypeError('controller is required');

  /** Screen as numbered text. Never throws. */
  async function read() {
    try {
      let text = String(await controller.read());
      if (text.length > maxChars) text = text.slice(0, maxChars) + '\n… (more below — scroll, then read again)';
      return { ok: true, text };
    } catch (e) {
      return { ok: false, text: 'Cannot read the screen: ' + String((e && e.message) || e).slice(0, 200) };
    }
  }

  /**
   * Run one command. Never throws.
   * @param {{ action: 'click'|'type'|'select'|'scroll', index?: number, value?: string, direction?: 'up'|'down', allowWrite?: boolean }} cmd
   */
  async function act(cmd) {
    try {
      const action = String((cmd && cmd.action) || '');
      const i = Number(cmd && cmd.index);
      if (!ACTIONS.includes(action)) return { ok: false, text: 'Unknown action.' };
      if (action === 'scroll') {
        const r = await controller.scroll({ down: cmd.direction !== 'up', index: Number.isInteger(i) ? i : undefined });
        return { ok: !!(r && r.success), text: String((r && r.message) || '').slice(0, 300) };
      }
      if (!(Number.isInteger(i) && i >= 0)) return { ok: false, text: 'Missing element number.' };
      const el = await controller.describe(i);
      if (!el) return { ok: false, text: 'No element number ' + i + ' — read the screen again and pick again.' };
      const verdict = decide(action, el, { allowWrite: !!cmd.allowWrite }, rules);
      if (!verdict.allowed) return { ok: false, stop: !!verdict.stop, text: verdict.reason + ' (' + (el.text || el.label || el.id || '').slice(0, 60) + ')' };

      const isWrite = action === 'click' && classify(el, rules) === 'write';
      const value = String(cmd.value == null ? '' : cmd.value);
      const run = () => (action === 'click' ? controller.click(i)
        : action === 'type' ? controller.type(i, value.slice(0, 2000))
          : controller.select(i, value.slice(0, 300)));
      const { res, notices } = await controller.watch(run, isWrite ? 1500 : 500);
      const warnings = notices.filter((t) => isWarning(t, rules));
      if (warnings.length) {
        return { ok: false, stop: true, text: 'STOPPED because the screen says: "' + warnings.join(' | ').slice(0, 400) + '". Report it to the user word for word; do not retry.' };
      }
      let text = (res && res.success ? 'Done. ' : 'Not done: ') + String((res && res.message) || '').slice(0, 300);
      if (notices.length) text += '\nOn screen: ' + notices.join(' | ').slice(0, 600);
      return { ok: !!(res && res.success), text };
    } catch (e) {
      return { ok: false, text: 'Cannot operate the screen: ' + String((e && e.message) || e).slice(0, 200) };
    }
  }

  return { read, act };
}
