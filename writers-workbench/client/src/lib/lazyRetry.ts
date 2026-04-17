import { lazy } from 'react';

/**
 * Retry dynamic imports once on failure (handles stale chunks after deploy).
 * When Vite rebuilds, chunk hashes change. If a user's browser has cached
 * the old HTML referencing old chunk filenames, the import will 404.
 * This wrapper reloads the page once to pick up the new HTML with correct hashes.
 */
export function lazyRetry(importFn: () => Promise<{ default: React.ComponentType<any> }>) {
  return lazy(() =>
    importFn().catch(() => {
      const key = 'chunk-retry';
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
      }
      sessionStorage.removeItem(key);
      return importFn();
    })
  );
}
