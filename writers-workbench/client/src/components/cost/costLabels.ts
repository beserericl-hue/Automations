import type { CostBreakdownRow, CostGroup } from '../../types/database';

/** The label a breakdown row is shown (and test-addressed) by, for the grouping in use. */
export function rowLabel(row: CostBreakdownRow, group: CostGroup): string {
  switch (group) {
    case 'operation': return row.operation ?? 'unknown';
    case 'operation_model': return `${row.operation ?? 'unknown'} · ${row.model ?? 'unknown'}`;
    case 'provider': return row.provider ?? 'unknown';
    case 'model': return `${row.model ?? 'unknown'}`;
    case 'project': return row.project_id ?? '(no project)';
    case 'day': return row.day ?? 'unknown';
    case 'user': return row.user_id ?? '(no user)';
  }
}

/** Stable data-testid for a breakdown row. */
export const testIdFor = (label: string): string => `cost-row-${label.replace(/[^A-Za-z0-9._-]+/g, '_')}`;

