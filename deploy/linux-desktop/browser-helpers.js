// Evaluated inside Browser Use's killable, task-scoped JavaScript worker.
// page, tabs and browser are Browser Use primitives; the caller injects playwrightPath.
var ui = await (async () => {
  const { chromium } = require(playwrightPath);
  const { performance } = require('node:perf_hooks');
  const connection = await chromium.connectOverCDP(cdpUrl);
  let observation;
  let sequence = 0;
  let pageWaitMs = 0;
  const marker = `dots-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const interactive = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'slider', 'spinbutton']);
  async function current() {
    await page.info();
    for (const candidate of connection.contexts()[0].pages()) {
      const session = await candidate.context().newCDPSession(candidate);
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo.targetId === page.targetId) return candidate;
      } finally { await session.detach(); }
    }
    throw new Error('The current tab disappeared. Inspect tabs before continuing; actions were not replayed.');
  }
  async function documentId() {
    return (await page.cdp('DOM.getDocument', { depth: 0 })).root.backendNodeId;
  }
  async function state() {
    const active = await current();
    const snapshot = await page.snapshot();
    const available = snapshot.nodes.filter(n => interactive.has(n.role));
    const controls = available.slice(0, 100).map(node => ({ ...node, name: node.name.slice(0, 160), ...(typeof node.value === 'string' ? { value: node.value.slice(0, 200) } : {}) }));
    const text = await active.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const state = { tabId: page.targetId, url: snapshot.url, title: snapshot.title.slice(0, 300), controls, text: text.slice(0, 6000), truncated: text.length > 6000 || available.length > 100 };
    // Keep the latest observation valid JSON within the executor's output budget.
    while (JSON.stringify(state).length > 8500) {
      state.truncated = true;
      if (state.text.length > 1000) state.text = state.text.slice(0, Math.max(1000, state.text.length - 1000));
      else if (controls.length) controls.pop();
      else { state.url = state.url.slice(0, 2048); break; }
    }
    observation = { targetId: page.targetId, documentId: await documentId(), ids: new Set(controls.map(n => n.id)) };
    return state;
  }
  async function locator(id) {
    if (!Number.isInteger(id) || !observation?.ids.has(id) || observation.targetId !== page.targetId || observation.documentId !== await documentId()) {
      throw new Error('Use an element id from ui.state() on the current document. Observe again after navigation.');
    }
    const { object } = await page.cdp('DOM.resolveNode', { backendNodeId: id });
    if (!object.objectId) throw new Error('The observed element no longer exists; inspect again.');
    const value = `${marker}-${id}`;
    try {
      const result = await page.cdp('Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: 'function(value) { if (!(this instanceof Element) || !this.isConnected) throw Error("Observed element detached"); this.setAttribute("data-coke-browser-ref", value); }',
        arguments: [{ value }],
      });
      if (result.exceptionDetails) throw new Error('The observed element detached; inspect again.');
    } finally { await page.cdp('Runtime.releaseObject', { objectId: object.objectId }); }
    const active = await current();
    // Include same-origin and cross-origin frames exposed by Playwright, without guessing a selector.
    for (const frame of active.frames()) {
      const match = frame.locator(`[data-coke-browser-ref="${value}"]`);
      if (await match.count() === 1) return match;
    }
    throw new Error('The observed element is no longer attached.');
  }
  function url(value) {
    const parsed = new URL(value);
    if (!['http:', 'https:', 'about:'].includes(parsed.protocol) || parsed.username || parsed.password || (parsed.protocol === 'about:' && parsed.href !== 'about:blank')) throw new Error('Use a credential-free HTTP(S) URL or about:blank.');
    return parsed.href;
  }
  const action = async (id, method, ...args) => {
    const target = await locator(id);
    await target[method](...args, { timeout: 10_000 });
    sequence++;
    return { action: method, id, completed: true };
  };
  async function wait(operation) {
    const began = performance.now();
    try { return await operation(); } finally { pageWaitMs += performance.now() - began; }
  }
  return {
    state,
    page: current,
    click: id => action(id, 'click'),
    fill: (id, text) => action(id, 'fill', String(text)),
    select: (id, value) => action(id, 'selectOption', value),
    check: (id, checked = true) => action(id, checked ? 'check' : 'uncheck'),
    press: async (key, id) => {
      if (id !== undefined) return action(id, 'press', key);
      await (await current()).keyboard.press(key); sequence++;
    },
    goto: async value => {
      observation = undefined;
      const active = await current();
      await wait(() => active.goto(url(value), { waitUntil: 'domcontentloaded', timeout: 25_000 }));
      sequence++;
      return state();
    },
    listTabs: async () => (await tabs.list()).map(t => ({ id: t.targetId, url: t.url, title: t.title, active: t.targetId === page.targetId })),
    open: async value => {
      page = await tabs.open(url(value || 'about:blank'));
      observation = undefined;
      await (await current()).bringToFront(); sequence++;
      return state();
    },
    switchTab: async id => {
      if (!(await tabs.list()).some(t => t.targetId === id)) throw new Error('Unknown tab id; list tabs again.');
      page = await tabs.get(id); observation = undefined;
      await (await current()).bringToFront(); sequence++;
      return state();
    },
    closeTabs: async ids => {
      const all = await tabs.list();
      if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => !all.some(t => t.targetId === id))) throw new Error('Supply existing ids from ui.listTabs().');
      const closing = new Set(ids);
      // Keep Chromium alive even when the user asks to close every page.
      if (closing.size === all.length) page = await tabs.open('about:blank');
      else if (closing.has(page.targetId)) page = await tabs.get(all.find(t => !closing.has(t.targetId)).targetId);
      observation = undefined;
      for (const id of closing) await (await tabs.get(id)).close();
      await (await current()).bringToFront(); sequence++;
      return { closed: [...closing], tabs: await ui.listTabs() };
    },
    waitFor: async ({ text, selector, exact = false, state: desired = 'visible', timeoutMs = 10_000 }) => {
      if (!text && !selector) throw new Error('Specify an observed text or selector to wait for.');
      const active = await current();
      let target = selector ? active.locator(selector) : active.getByText(text, { exact });
      // A text condition usually names a substring of the rendered result. Hidden
      // duplicates must not delay an already-visible match; this only waits, never clicks.
      if (desired === 'visible') target = target.filter({ visible: true });
      target = target.first();
      await wait(() => target.waitFor({ state: desired, timeout: Math.min(25_000, Math.max(1, timeoutMs)) }));
      return state();
    },
    get sequence() { return sequence; },
    get pageWaitMs() { return Math.round(pageWaitMs); },
  };
})();
