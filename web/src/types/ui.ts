/**
 * PayGuard — Frontend UI & Navigation Types
 */

export type DashboardRoute =
  | 'overview'
  | 'payments'
  | 'approvals'
  | 'agents'
  | 'policies'
  | 'vendors'
  | 'audit'
  | 'settings'
  | 'payment-detail';

export interface NavItem {
  id: DashboardRoute;
  label: string;
  badge?: number;
}

