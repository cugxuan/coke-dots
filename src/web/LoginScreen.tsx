import { useState } from 'react';
import { appFetch, appPath } from './api.ts';

export function LoginScreen({ googleConfigured, localAuthAvailable, e2eAuthAvailable }: { googleConfigured: boolean; localAuthAvailable: boolean; e2eAuthAvailable: boolean }) {
  const [desktopPending, setDesktopPending] = useState(false);
  const [desktopError, setDesktopError] = useState('');
  const [e2eEmail, setE2eEmail] = useState('alpha@example.test');
  const [localToken, setLocalToken] = useState('');
  const isElectron = /Electron/i.test(navigator.userAgent);
  const authError = new URLSearchParams(window.location.search).get('authError');
  const authErrors: Record<string, string> = { cancelled: '你取消了登录。', expired: '登录请求已过期，请重试。', invalid: '登录返回信息无效。', invalid_identity: 'Google 身份验证未通过。', missing_identity: 'Google 没有返回身份令牌。', sign_in_failed: 'Google 登录失败，请检查配置后重试。' };
  async function beginDesktopLogin() {
    setDesktopError(''); setDesktopPending(true);
    const random = new Uint8Array(32); crypto.getRandomValues(random);
    const handoffToken = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
    const authorization = new URL(appPath('/api/auth/desktop/start'), window.location.href);
    authorization.searchParams.set('handoffToken', handoffToken);
    const popup = window.open(authorization.toString(), '_blank');
    if (!popup && !isElectron) { setDesktopPending(false); setDesktopError('浏览器阻止了登录窗口，请允许弹出窗口后重试。'); return; }
    try {
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const response = await appFetch('/api/auth/desktop/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handoffToken }) });
        const data = await response.json();
        if (response.status === 202) continue;
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        window.location.reload();
        return;
      }
      throw new Error('登录等待超时，请重试。');
    } catch (error) { setDesktopError(error instanceof Error ? error.message : String(error)); }
    finally { setDesktopPending(false); }
  }
  async function signInE2e() {
    setDesktopError('');
    try {
      const response = await appFetch('/api/auth/e2e/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e2eEmail }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      window.location.reload();
    } catch (error) { setDesktopError(error instanceof Error ? error.message : String(error)); }
  }
  async function signInLocal() {
    setDesktopError(''); setDesktopPending(true);
    try {
      const response = await appFetch('/api/auth/local/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: localToken }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setLocalToken('');
      window.location.reload();
    } catch (error) { setDesktopError(error instanceof Error ? error.message : String(error)); }
    finally { setDesktopPending(false); }
  }
  return <main className="auth-page"><div className="auth-card">
    <div className="brand"><span className="brand-mark">●</span> Coke Dots</div>
    <h1>让你的个人代理持续推进工作</h1>
    <p>{localAuthAvailable ? '输入访问密钥，进入本机管理员工作区。' : '使用 Google 账号登录。'}任务、记录和浏览器会话按工作区隔离；模型 API 由 Coke Dots 实例统一配置。</p>
    {authError && <div className="auth-error">{authErrors[authError] || '登录失败，请重试。'}</div>}
    {desktopError && <div className="auth-error" role="alert">{desktopError}</div>}
    {localAuthAvailable ? <form className="local-login" onSubmit={event => { event.preventDefault(); void signInLocal(); }}>
      <label htmlFor="local-access-token">访问密钥</label>
      <input id="local-access-token" type="password" autoComplete="current-password" required value={localToken} onChange={event => setLocalToken(event.target.value)} />
      <button className="google-login" disabled={desktopPending || !localToken}>{desktopPending ? '正在登录…' : '进入本机工作区'}</button>
    </form> : googleConfigured ? isElectron ? <button className="google-login" disabled={desktopPending} onClick={() => void beginDesktopLogin()}><span>G</span>{desktopPending ? '等待浏览器完成登录…' : '使用 Google 登录'}</button> : <a className="google-login" href={appPath('/api/auth/google/start')}><span>G</span>使用 Google 登录</a> : <div className="auth-setup"><strong>需要配置 Google OAuth</strong><span>在本机服务环境中设置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET，然后重启服务。</span></div>}
    {e2eAuthAvailable && <div className="e2e-login"><label htmlFor="e2e-email">E2E 测试账号</label><input id="e2e-email" type="email" value={e2eEmail} onChange={event => setE2eEmail(event.target.value)} /><button data-testid="e2e-sign-in" className="google-login" onClick={() => void signInE2e()}>测试环境登录</button></div>}
    <small>{localAuthAvailable ? '访问密钥由本机部署管理员提供。模型 API 密钥请在登录后的设置中填写。' : '仅申请基本身份信息；Coke Dots 不会取得 Gmail 或 Google Drive 权限。'}</small>
  </div></main>;
}
