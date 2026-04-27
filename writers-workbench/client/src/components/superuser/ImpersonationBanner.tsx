// Sprint 8 (S8-4): persistent banner shown while a superuser is impersonating
// another user. Non-dismissable — clicking "End Impersonation" is the only
// exit. Renders nothing when there's no active session.

import { useEffect, useState } from 'react';
import { useUser } from '../../contexts/UserContext';

function formatElapsed(startedAt: string, now: number): string {
  const ms = now - new Date(startedAt).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export default function ImpersonationBanner() {
  const { isImpersonating, profile, realProfile, impersonationSession, endImpersonation } = useUser();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isImpersonating) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isImpersonating]);

  if (!isImpersonating || !profile || !impersonationSession) return null;

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex items-center justify-between gap-4 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-900"
    >
      <div className="flex flex-1 items-center gap-3">
        <span className="rounded bg-amber-300 px-2 py-0.5 text-xs font-bold uppercase tracking-wide">
          Impersonating
        </span>
        <span>
          You are acting as <strong>{profile.display_name || profile.user_id}</strong>{' '}
          ({profile.user_id}). All actions are performed as this user.
        </span>
        {realProfile && (
          <span className="text-amber-700">
            (real: {realProfile.display_name || realProfile.user_id})
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs">
          {formatElapsed(impersonationSession.started_at, now)}
        </span>
        <button
          type="button"
          className="rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700"
          onClick={() => void endImpersonation()}
        >
          End Impersonation
        </button>
      </div>
    </div>
  );
}
