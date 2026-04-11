import { lazy, Suspense, useState } from 'react';

const EveWidget = lazy(() => import('./EveWidget'));

export default function EveOrb() {
  const [active, setActive] = useState(false);

  return (
    <>
      {/* Floating orb button */}
      <button
        onClick={() => setActive(!active)}
        className={`fixed bottom-6 right-6 z-30 h-14 w-14 rounded-full shadow-lg transition-all ${
          active
            ? 'bg-red-500 hover:bg-red-600 scale-110'
            : 'bg-brand-600 hover:bg-brand-700 hover:scale-105'
        }`}
        title={active ? 'End conversation with Eve' : 'Talk to Eve'}
      >
        {active ? (
          <svg className="h-6 w-6 mx-auto text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="h-6 w-6 mx-auto text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
          </svg>
        )}
      </button>

      {/* Eve widget (lazy loaded) */}
      {active && (
        <Suspense fallback={null}>
          <EveWidget onEnd={() => setActive(false)} />
        </Suspense>
      )}
    </>
  );
}
