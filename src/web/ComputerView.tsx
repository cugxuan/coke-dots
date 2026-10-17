import { appFetch, appOriginRelativePath, appPath } from './api.ts';
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from 'react';
import './computer.css';

interface ComputerState { ready: boolean; owner: 'agent' | 'user'; url: string; title: string; backend?: 'local' | 'linux-desktop'; width?: number; height?: number }
export interface ComputerHandle { releaseControl: () => Promise<boolean> }

export function ComputerView({ ref, dotName, localComputerEnabled, onManageAccess, onError }: { ref?: Ref<ComputerHandle>; dotName: string; localComputerEnabled: boolean; onManageAccess: () => void; onError: (message: string) => void }) {
  const [state, setState] = useState<ComputerState>({ ready: false, owner: 'agent', url: '', title: '' });
  const [url, setUrl] = useState('');
  const [frame, setFrame] = useState(0);
  const [busy, setBusy] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const frameCleanup = useRef<(() => void) | null>(null);
  const currentState = useRef(state);
  const [targetOwner, setTargetOwner] = useState<ComputerState['owner'] | null>(null);
  const controlIntent = useRef<ComputerState['owner'] | null>(null);
  const controlVersion = useRef(0);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const pending = useRef(0);
  const revision = useRef(0);
  const mounted = useRef(false);
  const reportError = useRef(onError);
  reportError.current = onError;
  const noVncPath = appOriginRelativePath('/api/computer/novnc/websockify');
  const noVncViewer = appPath(`/api/computer/novnc/vnc_lite.html?scale=1&autoconnect=1&path=${encodeURIComponent(noVncPath)}`);

  async function refresh() {
    if (pending.current) return;
    const startedAt = revision.current;
    try {
      const response = await appFetch('/api/computer');
      if (!response.ok) return;
      const next = await response.json() as ComputerState;
      // A poll started before a click must not undo a confirmed ownership change.
      if (mounted.current && !pending.current && revision.current === startedAt) applyState(next);
    } catch { /* The main UI reports service connectivity. */ }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    const outside = (event: Event) => {
      if (event.target instanceof Node && !workspaceRef.current?.contains(event.target)) void releaseControl();
    };
    // Pointer events inside noVNC stay in its iframe. Focusing another iframe
    // (for example an output preview) also counts as leaving the computer.
    const blur = () => {
      setTimeout(() => {
        if (mounted.current && document.activeElement instanceof HTMLIFrameElement && !workspaceRef.current?.contains(document.activeElement)) void releaseControl();
      }, 0);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    window.addEventListener('blur', blur);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      window.removeEventListener('blur', blur);
      frameCleanup.current?.();
      void releaseControl();
    };
  }, []);
  useImperativeHandle(ref, () => ({ releaseControl }), []);
  useEffect(() => {
    if (state.owner !== 'user' || targetOwner === 'agent') frameCleanup.current?.();
  }, [state.owner, targetOwner]);

  function applyState(next: ComputerState) {
    currentState.current = next;
    if (mounted.current) { setState(next); if (next.ready) setFrame(Date.now()); }
  }

  async function requestAction(path: string, body: object = {}) {
    const response = await appFetch(`/api/computer/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json() as ComputerState & { error?: string };
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    applyState(result);
  }

  function enqueue(operation: () => Promise<void>) {
    revision.current += 1;
    pending.current += 1;
    if (mounted.current) setBusy(true);
    queue.current = queue.current.then(async () => {
      try { await operation(); return true; }
      catch (error) { reportError.current(error instanceof Error ? error.message : String(error)); return false; }
      finally { pending.current -= 1; if (mounted.current) setBusy(pending.current > 0); }
    });
    return queue.current;
  }

  function control(owner: ComputerState['owner'], point?: { x: number; y: number }) {
    const version = ++controlVersion.current;
    controlIntent.current = owner;
    if (mounted.current) setTargetOwner(owner);
    return enqueue(async () => {
      try {
        if (controlVersion.current !== version) return;
        if (currentState.current.owner !== owner) await requestAction(owner === 'user' ? 'take-over' : 'return-control');
        // The first click is sent only after takeover succeeds. If the user
        // already clicked outside, discard it and let the queued return finish.
        if (point && controlVersion.current === version) await requestAction('click', point);
        if (owner === 'user' && controlVersion.current === version) imageRef.current?.focus({ preventScroll: true });
      } finally {
        if (controlVersion.current === version) {
          controlIntent.current = null;
          if (mounted.current) setTargetOwner(null);
        }
      }
    });
  }

  function releaseControl() {
    if (controlIntent.current === 'agent' || (currentState.current.owner !== 'user' && controlIntent.current !== 'user')) return queue.current;
    return control('agent');
  }

  function input(path: string, body: object) {
    return enqueue(async () => {
      if (currentState.current.owner === 'user') await requestAction(path, body);
    });
  }

  function click(event: MouseEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    const rect = image.getBoundingClientRect();
    // The polling refresh can replace the screenshot URL while the previous
    // frame is still visible. Keep coordinate mapping stable during that load.
    const sourceWidth = image.naturalWidth || state.width || 1280;
    const sourceHeight = image.naturalHeight || state.height || 820;
    const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
    const offsetX = (rect.width - sourceWidth * scale) / 2;
    const offsetY = (rect.height - sourceHeight * scale) / 2;
    const localX = event.clientX - rect.left - offsetX;
    const localY = event.clientY - rect.top - offsetY;
    if (localX < 0 || localY < 0 || localX > sourceWidth * scale || localY > sourceHeight * scale) return;
    const point = { x: Math.round(localX / scale), y: Math.round(localY / scale) };
    if (currentState.current.owner === 'user' && controlIntent.current !== 'agent') void input('click', point);
    else void control('user', point);
  }

  function keyDown(event: KeyboardEvent<HTMLImageElement>) {
    if (state.owner !== 'user') {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void control('user'); }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      void input('type', { text: event.key });
      return;
    }
    const key = event.key === ' ' ? 'Space' : event.key;
    if (['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'].includes(key)) {
      event.preventDefault();
      void input('press', { key });
    }
  }

  function focusDesktop(iframe: HTMLIFrameElement) {
    frameCleanup.current?.();
    const frameDocument = iframe.contentDocument;
    const frameWindow = iframe.contentWindow;
    if (!frameDocument || !frameWindow) return;
    // noVNC inserts its canvas asynchronously after the iframe load event.
    // Wait for that canvas so the initial screenshot click also enables typing.
    const observer = new MutationObserver(focus);
    const timeout = window.setTimeout(() => observer.disconnect(), 10_000);
    const blur = () => window.setTimeout(() => {
      // Moving directly between two iframes does not blur the parent window.
      if (mounted.current && iframe.isConnected && !workspaceRef.current?.contains(document.activeElement)) void releaseControl();
    }, 0);
    frameWindow.addEventListener('blur', blur);
    frameCleanup.current = () => { observer.disconnect(); window.clearTimeout(timeout); frameWindow.removeEventListener('blur', blur); };
    function focus() {
      if (!iframe.isConnected || controlIntent.current === 'agent' || currentState.current.owner !== 'user') { frameCleanup.current?.(); return; }
      const canvas = frameDocument?.querySelector('canvas');
      if (canvas) { canvas.focus({ preventScroll: true }); observer.disconnect(); window.clearTimeout(timeout); }
    }
    observer.observe(frameDocument, { childList: true, subtree: true });
    focus();
  }

  if (!localComputerEnabled && state.backend !== 'linux-desktop') return <section className="computer-view"><div className="computer-empty" data-testid="computer-access-disabled"><div className="computer-icon">▣</div><h2>本机 Chrome 工作区已关闭</h2><p>此工作区尚未允许 Dot 使用本机上的隔离 Chrome 浏览器。</p><button onClick={onManageAccess}>更改电脑访问</button></div></section>;

  return <section className="computer-view" aria-label={`${dotName} 的电脑`}>
    {!state.ready ? <div className="computer-empty"><div className="computer-icon">▣</div><h2>打开独立电脑</h2><p>{state.backend === 'linux-desktop' ? '这台 Debian 云电脑和 Agent 运行时在独立工作区内持续运行。' : '工作区会话保存在 Coke Dots 专用 Chrome 配置中。'}</p><button disabled={busy} onClick={() => void enqueue(() => requestAction('open', { dotName }))}>打开电脑</button></div> : <div ref={workspaceRef} className={`computer-workspace${state.owner === 'user' ? ' has-user-control' : ''}`} data-testid="computer-workspace">
      {state.backend === 'linux-desktop' ? <div className="computer-stage is-linux-desktop" data-testid="linux-desktop-stage">
        {state.owner === 'user' && targetOwner !== 'agent'
          ? <iframe title="Linux 云桌面" data-testid="linux-desktop-view" src={noVncViewer} onLoad={event => focusDesktop(event.currentTarget)} />
          : <img ref={imageRef} src={appPath(`/api/computer/screenshot?t=${frame}`)} alt="Linux 云桌面画面" role="button" aria-label="点击云电脑画面接管" tabIndex={0} onClick={click} onKeyDown={keyDown} />}
      </div> : <div className="computer-stage">
        <div className="computer-browser-window">
          <div className="browser-window-chrome">
            <div className="browser-tab-strip"><span className="browser-dots"><i /><i /><i /></span><span className="browser-tab-title" title={state.title || 'New tab'}>{state.title || 'New tab'}</span><span className="browser-tab-add" aria-hidden="true">＋</span></div>
            <div className="browser-toolbar">
              <button type="button" className="browser-nav-icon" aria-label="后退" disabled>‹</button>
              <button type="button" className="browser-nav-icon" aria-label="前进" disabled>›</button>
              <span className="browser-nav-icon browser-refresh-icon" aria-hidden="true">↻</span>
              <form onSubmit={event => { event.preventDefault(); if (state.owner === 'user') void input('navigate', { url }); }}>
                <input aria-label="电脑网址" value={url} onChange={event => setUrl(event.target.value)} placeholder={state.url && state.url !== 'about:blank' ? state.url : ''} disabled={state.owner !== 'user'} />
              </form>
              <span className="browser-toolbar-menu" aria-hidden="true">⋮</span>
            </div>
          </div>
          <div className="browser-page-frame"><img ref={imageRef} src={appPath(`/api/computer/screenshot?t=${frame}`)} alt="独立浏览器画面" role="button" aria-label="点击浏览器画面接管" tabIndex={0} onClick={click} onKeyDown={keyDown} /></div>
        </div>
        <div className="computer-dock" aria-hidden="true"><span className="dock-chrome">◉</span><span className="dock-terminal">›_</span><span className="dock-files">▰</span></div>
      </div>}
      <div className={`computer-controlbar${state.owner === 'user' ? ' is-user-control' : ''}`}>
        <span className="computer-owner" role="status"><i />{state.owner === 'user' ? 'You have control' : `${dotName} has control`}</span>
        <button className="take-button" disabled={busy} onClick={() => void control(state.owner === 'user' ? 'agent' : 'user')}>{state.owner === 'user' ? 'Return control' : 'Take over'}</button>
      </div>
    </div>}
  </section>;
}
