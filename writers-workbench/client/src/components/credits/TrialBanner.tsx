// Sprint 8 (S8-5): countdown banner shown for active trial subscriptions.
// Turns red in the last 3 days. Renders nothing for non-trial users.

import { Link } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';

export default function TrialBanner() {
  const { isTrialUser, trialDaysRemaining } = usePermissions();
  if (!isTrialUser || trialDaysRemaining === null) return null;

  const urgent = trialDaysRemaining <= 3;
  const expired = trialDaysRemaining <= 0;

  if (expired) {
    return (
      <div role="alert" className="sticky top-0 z-40 flex items-center justify-between gap-4 border-b border-red-300 bg-red-100 px-4 py-2 text-sm text-red-900">
        <span>
          <strong>Your free trial has expired.</strong> Upgrade to continue creating content.
        </span>
        <Link to="/credits" className="rounded bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800">
          Upgrade now
        </Link>
      </div>
    );
  }

  return (
    <div className={`sticky top-0 z-40 flex items-center justify-between gap-4 border-b px-4 py-2 text-sm ${urgent ? 'border-red-300 bg-red-100 text-red-900' : 'border-blue-300 bg-blue-50 text-blue-900'}`}>
      <span>
        You have <strong>{trialDaysRemaining}</strong> day{trialDaysRemaining === 1 ? '' : 's'} remaining in your free trial.
      </span>
      <Link to="/credits" className={`rounded px-3 py-1 text-xs font-semibold text-white ${urgent ? 'bg-red-700 hover:bg-red-800' : 'bg-blue-600 hover:bg-blue-700'}`}>
        Upgrade
      </Link>
    </div>
  );
}
