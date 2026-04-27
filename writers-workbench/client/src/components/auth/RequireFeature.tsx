// Sprint 8 (S8-8): tier-feature-gated render wrapper. Default fallback shows
// a soft upgrade card; pass `fallback={null}` to silently hide instead.

import type { ReactNode } from 'react';
import { usePermissions } from '../../hooks/usePermissions';

export interface RequireFeatureProps {
  feature: string;
  /** Override the default upgrade card. Pass `null` to hide silently. */
  fallback?: ReactNode;
  children: ReactNode;
}

export function RequireFeature({ feature, fallback, children }: RequireFeatureProps) {
  const { hasFeature, tierDisplayName } = usePermissions();
  if (hasFeature(feature)) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  return <UpgradePromptCard feature={feature} tierDisplayName={tierDisplayName} />;
}

function humanizeFeature(key: string): string {
  switch (key) {
    case 'kdp_export': return 'KDP Export';
    case 'cover_art': return 'Cover Art Generation';
    case 'social_media': return 'Social Media Repurposing';
    default: return key.replace(/_/g, ' ');
  }
}

interface UpgradePromptProps {
  feature: string;
  tierDisplayName: string | null;
}

function UpgradePromptCard({ feature, tierDisplayName }: UpgradePromptProps) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
      <p className="font-medium text-amber-900">
        {humanizeFeature(feature)} requires an upgraded plan
      </p>
      <p className="mt-1 text-amber-800">
        You're on the {tierDisplayName ?? 'current'} plan.{' '}
        <a href="/credits" className="underline font-medium">
          Upgrade to unlock this feature
        </a>
        .
      </p>
    </div>
  );
}
