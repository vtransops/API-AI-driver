/**
 * Web controller for screen-agent.js, built on @page-agent/page-controller (Alibaba, MIT).
 *
 * page-controller is the "eyes and hands": it turns the DOM into numbered text and clicks / types / selects /
 * scrolls by number. It never calls a model. This adapter adds what the guard needs: a description of each element
 * (text, label, id, data-ai marker, form membership) and a watcher for notifications that appear after an action.
 *
 * Two attributes are honoured by page-controller and set here on the elements listed in `hide` (e.g. the assistant's
 * own chat panel): data-page-agent-ignore="true" drops the element and its subtree from the text it returns, and
 * data-page-agent-not-interactive keeps it from getting a number. Hidden from reading AND from acting.
 *
 * page-controller also ships an `executeJavascript` helper that uses eval. This adapter never calls it; serve the page
 * with a Content Security Policy without 'unsafe-eval' so the browser refuses it anyway.
 */

/** Build the description used by classify() from a real DOM element. */
export function describeElement(node) {
  if (!node || !node.getAttribute) return null;
  const host = node.closest ? node.closest('[data-ai]') : null;
  return {
    marker: host ? host.getAttribute('data-ai') : '',
    text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    label: [node.getAttribute('aria-label'), node.getAttribute('title'), node.type === 'submit' || node.type === 'button' ? node.value : '']
      .filter(Boolean).join(' '),
    id: [node.id, node.getAttribute('name')].filter(Boolean).join(' '),
    tag: node.tagName ? node.tagName.toLowerCase() : '',
    type: node.type ? String(node.type).toLowerCase() : '',
    inForm: !!node.form,
  };
}

/**
 * @param {object} opts
 * @param {() => Promise<any>} opts.loadPageController  returns a PageController instance
 * @param {string[]} [opts.hide]             ids the assistant must neither see nor press
 * @param {string[]} [opts.noticeSelectors]  where notifications appear after an action
 */
export function createWebController({
  loadPageController,
  hide = [],
  noticeSelectors = ['[role="alert"]', '[role="alertdialog"]', '[aria-live="assertive"]', '.toast.show'],
} = {}) {
  let pc = null;
  const ready = async () => {
    if (!pc) pc = await loadPageController();
    for (const id of hide) {
      const n = document.getElementById(id);
      if (n) { n.setAttribute('data-page-agent-ignore', 'true'); n.setAttribute('data-page-agent-not-interactive', 'true'); }
    }
    return pc;
  };

  const textOf = (n) => String(n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const currentNotices = () => {
    const out = [];
    for (const sel of noticeSelectors) document.querySelectorAll(sel).forEach((n) => { const t = textOf(n); if (t) out.push(t); });
    return out;
  };

  return {
    async read() {
      await ready();
      const st = await pc.getBrowserState();
      return [st.header, st.content, st.footer].filter(Boolean).join('\n');
    },
    async describe(i) {
      await ready();
      if (!pc.isIndexed) await pc.updateTree();
      const entry = pc.selectorMap && pc.selectorMap.get ? pc.selectorMap.get(i) : null;
      return describeElement(entry && (entry.ref || entry.element));
    },
    click: async (i) => (await ready()).clickElement(i),
    type: async (i, text) => (await ready()).inputText(i, text),
    select: async (i, option) => (await ready()).selectOption(i, option),
    scroll: async ({ down, index }) => (await ready()).scroll({ down, numPages: 1, index }),

    /**
     * Notices that APPEAR OR CHANGE while `run` executes. A message already on screen before the action is not
     * reported again (an old error must not stop the next, unrelated action); the same message rewritten during the
     * action is reported.
     */
    watch(run, waitMs) {
      const before = new Set(currentNotices());
      const fresh = [];
      const add = (t) => { if (t && !fresh.includes(t)) fresh.push(t); };
      const onRecords = (records) => {
        for (const r of records) {
          const node = r.target && r.target.nodeType === 1 ? r.target : r.target && r.target.parentElement;
          if (!node || !node.closest) continue;
          for (const sel of noticeSelectors) { const h = node.closest(sel); if (h) add(textOf(h)); }
        }
      };
      const ob = typeof MutationObserver === 'function' ? new MutationObserver(onRecords) : null;
      if (ob) ob.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
      return Promise.resolve(run()).then((res) => new Promise((done) => setTimeout(done, waitMs)).then(() => {
        if (ob) { onRecords(ob.takeRecords()); ob.disconnect(); }
        for (const t of currentNotices()) if (!before.has(t)) add(t);
        return { res, notices: fresh };
      }));
    },
  };
}
