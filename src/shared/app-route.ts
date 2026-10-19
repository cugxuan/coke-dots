export type AppView = 'home' | 'chat' | 'activity' | 'scheduled' | 'computer' | 'profile' | 'pages';

export interface AppRoute {
  view: AppView;
  selected: string | null;
  selectedPageId: string | null;
  scheduledKey: string | null;
}

export function routeForView(view: AppView): AppRoute {
  return { view, selected: null, selectedPageId: null, scheduledKey: null };
}

const validId = (value: string | null): value is string => Boolean(value && /^[a-zA-Z0-9_-]{1,128}$/.test(value));

/** Parse only app pages, never API routes, assets, or paths outside the mount. */
export function parseAppRoute(pathname: string, search = '', baseUrl = '/'): AppRoute | null {
  const base = baseUrl.replace(/\/+$/, '');
  if (base && pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  const path = pathname.slice(base.length).replace(/\/$/, '') || '/';
  if (path === '/') return routeForView('home');
  let parts: string[];
  try { parts = path.slice(1).split('/').map(decodeURIComponent); }
  catch { return null; }
  const query = new URLSearchParams(search);
  if (parts[0] === 'chat' && parts.length <= 2 && (parts.length === 1 || validId(parts[1]))) {
    const pageId = query.get('page');
    if (pageId !== null && !validId(pageId)) return null;
    return { ...routeForView('chat'), selected: parts[1] || null, selectedPageId: pageId };
  }
  if (parts[0] === 'pages' && parts.length <= 2 && (parts.length === 1 || validId(parts[1]))) {
    return { ...routeForView('pages'), selectedPageId: parts[1] || null };
  }
  if (parts[0] === 'scheduled' && parts.length === 3 && ['tasks', 'watches'].includes(parts[1]) && validId(parts[2])) {
    return { ...routeForView('scheduled'), scheduledKey: `${parts[1] === 'tasks' ? 'task' : 'watch'}:${parts[2]}` };
  }
  if (parts.length !== 1) return null;
  if (parts[0] === 'computer') {
    const taskId = query.get('task');
    return taskId === null || validId(taskId) ? { ...routeForView('computer'), selected: taskId } : null;
  }
  const views: Record<string, AppView> = { activity: 'activity', scheduled: 'scheduled', settings: 'profile' };
  return Object.hasOwn(views, parts[0]) ? routeForView(views[parts[0]]) : null;
}

export function appRoutePath(route: AppRoute): string {
  const encode = encodeURIComponent;
  switch (route.view) {
    case 'home': return '/';
    case 'chat': return `/chat${route.selected ? `/${encode(route.selected)}` : ''}${route.selectedPageId ? `?page=${encode(route.selectedPageId)}` : ''}`;
    case 'pages': return `/pages${route.selectedPageId ? `/${encode(route.selectedPageId)}` : ''}`;
    case 'computer': return `/computer${route.selected ? `?task=${encode(route.selected)}` : ''}`;
    case 'profile': return '/settings';
    case 'activity': return '/activity';
    case 'scheduled': {
      const [kind, id] = route.scheduledKey?.split(':') || [];
      return id && ['task', 'watch'].includes(kind) ? `/scheduled/${kind === 'task' ? 'tasks' : 'watches'}/${encode(id)}` : '/scheduled';
    }
  }
}

/** OAuth can return only to a known page within this app's configured mount. */
export function appLoginReturnUrl(baseUrl: string, requested: string | null): string {
  const base = new URL(baseUrl);
  const mount = base.pathname.replace(/\/+$/, '');
  const fallback = `${base.origin}${mount}/`;
  if (!requested?.startsWith('/') || requested.startsWith('//') || requested.includes('\\')) return fallback;
  const target = new URL(requested, base.origin);
  const route = target.origin === base.origin ? parseAppRoute(target.pathname, target.search, mount) : null;
  return route ? `${base.origin}${mount}${appRoutePath(route)}` : fallback;
}
