import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { appRoutePath, parseAppRoute, routeForView, type AppRoute } from '../shared/app-route.ts';
import { appPath } from './api.ts';

function readRoute() {
  return parseAppRoute(window.location.pathname, window.location.search, import.meta.env.BASE_URL) || routeForView('home');
}

export function useAppRoute() {
  const [route, setRoute] = useState(readRoute);
  const historyMode = useRef<'push' | 'replace'>('replace');

  useEffect(() => {
    const restore = () => {
      historyMode.current = 'replace';
      setRoute(readRoute());
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  // A single route state batches existing view/selection updates into one entry.
  useLayoutEffect(() => {
    const url = new URL(appPath(appRoutePath(route)), window.location.href);
    const current = new URL(window.location.href);
    for (const key of ['authError', 'slack', 'slackError']) {
      const value = current.searchParams.get(key);
      if (value !== null) url.searchParams.set(key, value);
    }
    url.hash = current.hash;
    if (url.href !== current.href) {
      window.history[historyMode.current === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
    }
    historyMode.current = 'push';
  }, [route]);

  const setters = useMemo(() => {
    function field<K extends keyof AppRoute>(key: K) {
      return (value: SetStateAction<AppRoute[K]>) => setRoute(current => ({
        ...current,
        ...(key === 'view' ? { scheduledKey: null } : {}),
        [key]: typeof value === 'function' ? value(current[key]) : value,
      }));
    }
    return { setView: field('view'), setSelected: field('selected'), setSelectedPageId: field('selectedPageId'), setScheduledKey: field('scheduledKey') };
  }, []);
  const replaceRoute = useCallback((next: AppRoute) => {
    historyMode.current = 'replace';
    setRoute(next);
  }, []);
  return { ...route, ...setters, replaceRoute };
}
