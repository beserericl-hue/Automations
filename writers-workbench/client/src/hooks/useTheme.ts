import { useState, useEffect, useCallback } from 'react';

type Theme = 'light' | 'dark' | 'system';

function getEffectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }
  return theme;
}

function applyTheme(effective: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  if (effective === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem('theme');
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch {
      // localStorage may not be available in tests
    }
    return 'system';
  });

  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() =>
    getEffectiveTheme(theme)
  );

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    try { localStorage.setItem('theme', newTheme); } catch { /* noop */ }
    const effective = getEffectiveTheme(newTheme);
    setEffectiveTheme(effective);
    applyTheme(effective);
  }, []);

  // Apply on mount
  useEffect(() => {
    applyTheme(getEffectiveTheme(theme));
  }, []);

  // Listen for system preference changes when in "system" mode
  useEffect(() => {
    if (theme !== 'system') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      const effective = e.matches ? 'dark' : 'light';
      setEffectiveTheme(effective);
      applyTheme(effective);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next = effectiveTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
  }, [effectiveTheme, setTheme]);

  return { theme, effectiveTheme, setTheme, toggleTheme };
}
