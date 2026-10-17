import { useState } from 'react';
import type { AuthContext } from './ui-types.ts';

export function WorkspaceSwitcher({ auth, onSwitch, onCreate, onError }: { auth: AuthContext; onSwitch: (id: string) => Promise<void>; onCreate: (name: string) => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  return <div className="workspace-switcher"><label><span>工作区</span><select value={auth.tenant.id} onChange={event => void onSwitch(event.target.value)}>{auth.tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.role}</option>)}</select></label>{creating ? <form onSubmit={event => { event.preventDefault(); void onCreate(name.trim()).then(() => { setName(''); setCreating(false); }).catch(error => onError(String(error))); }}><input aria-label="新工作区名称" autoFocus maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="工作区名称" /><button disabled={!name.trim()}>创建</button><button type="button" onClick={() => setCreating(false)}>取消</button></form> : <button className="new-workspace" onClick={() => setCreating(true)}>＋ 新建工作区</button>}</div>;
}
