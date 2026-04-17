import { Suspense, useState } from 'react';
import { lazyRetry } from '../../lib/lazyRetry';

const EveWidget = lazyRetry(() => import('./EveWidget'));

export default function EveOrb() {
  const [active, setActive] = useState(false);

  return (
    <div className="relative">
      {/* Eve button in sidebar */}
      <button
        onClick={() => setActive(!active)}
        className={`flex w-full items-center gap-3 px-3 py-2 text-sm whitespace-nowrap transition-colors ${
          active
            ? 'bg-brand-50 text-brand-700 font-medium dark:bg-brand-950 dark:text-brand-300'
            : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
        }`}
        title="Talk to Eve"
      >
        <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
        </svg>
        <span className="truncate">Talk to Eve</span>
        {active && <span className="ml-auto h-2 w-2 rounded-full bg-green-500 animate-pulse shrink-0" />}
      </button>

      {/* Eve widget popover */}
      {active && (
        <Suspense fallback={
          <div className="absolute bottom-full left-0 mb-2 w-64 rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <p className="text-sm text-gray-500">Loading Eve...</p>
          </div>
        }>
          <div className="absolute bottom-full left-0 mb-2 z-50">
            <EveWidget onEnd={() => setActive(false)} />
          </div>
        </Suspense>
      )}
    </div>
  );
}
