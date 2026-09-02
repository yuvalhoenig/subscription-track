/** Small shared hooks. */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Load data on mount, with loading/error state and a manual reload.
 *
 * Guards against the two classic async-in-React bugs: setting state after
 * unmount, and an earlier request resolving after a later one and
 * overwriting fresher data.
 */
export function useAsync(loader, deps = [], { immediate = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(immediate);
  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loader();
      // Drop the result if a newer request has started or we unmounted.
      if (mounted.current && id === requestId.current) setData(result);
      return result;
    } catch (caught) {
      if (mounted.current && id === requestId.current) setError(caught);
      return undefined;
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (immediate) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, immediate]);

  return { data, error, loading, reload: run, setData };
}

/** Debounce a rapidly-changing value (search boxes). */
export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Run a callback when a click or Escape lands outside `ref`. */
export function useDismissable(ref, onDismiss, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onDismiss();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, onDismiss, active]);
}

/** Persist a value in localStorage, tolerating unavailable storage. */
export function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : JSON.parse(stored);
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next) => {
      setValue((current) => {
        const resolved = typeof next === 'function' ? next(current) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* storage unavailable */
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, update];
}

/** True once the viewport is at or below `breakpoint`. */
export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= breakpoint,
  );
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = (event) => setIsMobile(event.matches);
    setIsMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [breakpoint]);
  return isMobile;
}
