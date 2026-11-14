// Pure decision rules of screen-agent.js and the guard over a fake (non-web) controller — no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, decide, isWarning, createScreenAgent } from '../src/screen-agent.js';

test('explicit markers win over text', () => {
  assert.equal(classify({ marker: 'block', text: 'Lọc' }), 'block');
  assert.equal(classify({ marker: 'write', text: 'Chuyển vào giỏ' }), 'write');
  assert.equal(classify({ marker: 'normal', text: 'Gửi' }), 'normal');
});

test('decisions, sending, money, orders and deletes are blocked in many kinds of software', () => {
  const cases = [
    // transport dispatch
    '✅ Xác nhận & Bắt đầu', 'Đẩy lên xe',
    // shop
    'Đặt hàng', 'Mua ngay', 'Hoàn tiền', 'Place order', 'Checkout', 'Refund',
    // accounting
    'Phát hành hoá đơn', 'Ký số', 'Khoá sổ', 'Chuyển khoản',
    // email / CRM / social
    'Gửi báo giá', 'Send', 'Reply all', 'Publish', 'Đăng bài',
    // admin
    'Xoá người dùng', 'Phân quyền', 'Đổi mật khẩu', 'Delete account', 'Log out', 'Approve',
    // English labels of the demo screens
    '✅ Confirm & Start', 'Issue invoice', 'Issue an invoice', 'Close period', 'Transfer',
  ];
  for (const t of cases) assert.equal(classify({ text: t }), 'block', t);
});

test('save buttons are write, leading icons ignored', () => {
  for (const t of ['💾 Lưu ghi chú', 'Lưu', 'Cập nhật', 'Save', '✅ Confirm changes', 'Add to cart', 'Save entry', 'Save address']) assert.equal(classify({ text: t }), 'write', t);
});

test('submit button writes only inside a form', () => {
  assert.equal(classify({ text: 'OK', tag: 'button', type: 'submit', inForm: true }), 'write');
  assert.equal(classify({ text: 'OK', tag: 'button', type: 'submit', inForm: false }), 'normal');
});

test('ordinary controls are normal', () => {
  for (const t of ['Lọc', 'Mở giỏ', 'Xem kết quả', 'Filter', 'Search', 'Tìm kiếm', '']) assert.equal(classify({ text: t }), 'normal', t);
});

test('blocked controls stop the model; scroll is always allowed', () => {
  const v = decide('click', { text: 'Gửi báo giá' });
  assert.equal(v.allowed, false);
  assert.equal(v.stop, true);
  assert.match(v.reason, /BLOCKED/);
  assert.equal(decide('scroll', null).allowed, true);
});

test('text-based block applies to clicks only; marker block applies to typing too', () => {
  assert.equal(decide('type', { text: '', label: 'Ngày gửi' }).allowed, true);
  assert.equal(decide('type', { marker: 'block', text: '' }).allowed, false);
});

test('write buttons need auto-save', () => {
  const no = decide('click', { text: 'Lưu' });
  assert.equal(no.allowed, false);
  assert.match(no.reason, /NOT ALLOWED/);
  assert.equal(decide('click', { text: 'Lưu' }, { allowWrite: true }).allowed, true);
  assert.equal(decide('type', { text: 'Lưu' }).allowed, true, 'typing into a field is not pressing the button');
});

test('unknown actions are refused', () => {
  assert.equal(decide('eval', { text: 'Lọc' }).allowed, false);
});

test('warnings are recognised in Vietnamese and English', () => {
  for (const t of ['Lỗi: chưa nhập ghi chú.', 'Không thể lưu', 'Đơn bị trùng', 'Error: invalid date', 'Request failed', 'Insufficient balance']) assert.equal(isWarning(t), true, t);
  for (const t of ['Đã lưu ghi chú.', 'Đã lọc danh sách.', 'Saved']) assert.equal(isWarning(t), false, t);
});

/* A fake controller standing in for a desktop or mobile adapter: the guard does not care what the platform is. */
function fakeController(elements, onClickNotice = () => []) {
  const pressed = [];
  return {
    pressed,
    read: async () => elements.map((e, i) => '[' + i + ']<button>' + e.text + ' />').join('\n'),
    describe: async (i) => elements[i] || null,
    click: async (i) => { pressed.push(i); return { success: true, message: 'clicked ' + i }; },
    type: async (i, t) => { pressed.push(i + ':' + t); return { success: true, message: 'typed' }; },
    select: async () => ({ success: true, message: 'selected' }),
    scroll: async () => ({ success: true, message: 'scrolled' }),
    watch: async (run) => { const res = await run(); return { res, notices: onClickNotice(pressed[pressed.length - 1]) }; },
  };
}

test('guard over any controller: blocked controls never reach the platform', async () => {
  const c = fakeController([{ text: 'Mở hồ sơ' }, { text: 'Chuyển tiền' }, { text: 'Lưu' }]);
  const agent = createScreenAgent({ controller: c });
  assert.match((await agent.read()).text, /\[1\]<button>Chuyển tiền/);
  assert.equal((await agent.act({ action: 'click', index: 0 })).ok, true);
  const blocked = await agent.act({ action: 'click', index: 1 });
  assert.equal(blocked.stop, true);
  const write = await agent.act({ action: 'click', index: 2 });
  assert.equal(write.stop, true);
  assert.deepEqual(c.pressed, [0], 'only the normal control was pressed');
  assert.equal((await agent.act({ action: 'click', index: 2, allowWrite: true })).ok, true);
  assert.deepEqual(c.pressed, [0, 2]);
});

test('guard over any controller: a warning on screen stops the model', async () => {
  const c = fakeController([{ text: 'Lưu' }], () => ['Lỗi: thiếu số tài khoản']);
  const agent = createScreenAgent({ controller: c });
  const r = await agent.act({ action: 'click', index: 0, allowWrite: true });
  assert.equal(r.stop, true);
  assert.match(r.text, /STOPPED.*thiếu số tài khoản/);
});

test('read() caps very long screens', async () => {
  const agent = createScreenAgent({ controller: { read: async () => 'x'.repeat(20000) }, maxChars: 100 });
  const r = await agent.read();
  assert.equal(r.ok, true);
  assert.ok(r.text.length < 200);
});
