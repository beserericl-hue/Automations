// Sprint 8 (S8-8): role-gated render wrapper. Respects hierarchy
// (superuser > admin > user). Renders `fallback` (or null) when blocked.

import type { ReactNode } from 'react';
import { usePermissions, type RoleRequirement } from '../../hooks/usePermissions';

export interface RequireRoleProps {
  role: RoleRequirement;
  fallback?: ReactNode;
  children: ReactNode;
}

export function RequireRole({ role, fallback = null, children }: RequireRoleProps) {
  const { hasRole } = usePermissions();
  if (!hasRole(role)) return <>{fallback}</>;
  return <>{children}</>;
}
