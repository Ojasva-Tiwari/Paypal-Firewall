/**
 * PayGuard — Frontend API Type Definitions
 * Matches backend responses from src/api/owner.ts and src/api/auth.ts
 */

export interface SessionResponse {
  authenticated: boolean;
  owner?: {
    id: string;
    displayName: string;
  };
  csrfToken?: string;
}

export interface LoginResponse {
  ok: boolean;
  owner: {
    id: string;
    displayName: string;
  };
  csrfToken: string;
}

export interface BudgetOverview {
  currency: string;
  globalDailyBudgetMinor: number;
  globalDailyBudgetDecimal: string;
  spentRolling24hMinor: number;
  spentRolling24hDecimal: string;
  reservedRolling24hMinor: number;
  reservedRolling24hDecimal: string;
  totalCommittedMinor: number;
  totalCommittedDecimal: string;
  remainingBudgetMinor: number;
  remainingBudgetDecimal: string;
}

export interface DecisionCounts24h {
  total: number;
  allowed: number;
  held: number;
  denied: number;
}

export interface RecentActivityItem {
  id: string;
  timestamp: string;
  status: string;
  decision: string | null;
  reasons: string[];
  vendorId: string;
  vendorName: string;
  amountMinor: number;
  amountDecimal: string;
  currency: string;
  agentId: string;
  agentName: string;
}

export interface OverviewResponse {
  budget: BudgetOverview;
  counts24h: DecisionCounts24h;
  recentActivity: RecentActivityItem[];
}

export interface PaymentRequestSummary {
  id: string;
  agentId: string;
  agentName: string;
  vendorId: string;
  vendorName: string;
  amountMinor: number;
  amountDecimal: string;
  currency: string;
  purpose: string;
  category: string | null;
  status: string;
  decision: string | null;
  reasons: string[];
  createdAt: string;
  expiresAt: string | null;
}

export interface PaymentRequestsListResponse {
  items: PaymentRequestSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  dailyBudgetMinor: number;
  dailyBudgetDecimal: string;
  createdAt: string;
}

export type AgentDto = AgentSummary;
export type VendorDto = VendorSummary;
export type PolicyDto = PolicySummary;
export type PaymentRequestDto = PaymentRequestSummary;

export interface AgentsResponse {
  agents: AgentSummary[];
}

export interface CreateAgentInput {
  name: string;
  daily_budget_decimal?: string;
  daily_budget_minor?: number;
}

export interface CreateAgentResponse {
  id: string;
  name: string;
  status: 'ACTIVE';
  dailyBudgetMinor: number;
  dailyBudgetDecimal: string;
  apiKey: string;
  createdAt: string;
}

export interface SuspendAgentResponse {
  id: string;
  status: 'SUSPENDED';
}

export interface VendorSummary {
  id: string;
  name: string;
  status: 'ACTIVE' | 'UNVERIFIED' | 'BLOCKED';
  categories: string[];
  currencies: string[];
  hasVaultToken: boolean;
  createdAt: string;
}

export interface VendorsResponse {
  vendors: VendorSummary[];
}

export interface CreateVendorInput {
  id: string;
  name: string;
  status: 'ACTIVE' | 'UNVERIFIED' | 'BLOCKED';
  categories: string[];
  currencies: string[];
  connector_key?: string;
}

export interface CreateVendorResponse {
  id: string;
  name: string;
  status: 'ACTIVE' | 'UNVERIFIED' | 'BLOCKED';
  categories: string[];
  currencies: string[];
  createdAt: string;
}

export interface PolicySummary {
  id: string;
  version: number;
  rules: Record<string, unknown>;
  author: string;
  active: boolean;
  createdAt: string;
}

export interface PoliciesResponse {
  activePolicy: PolicySummary | null;
  history: PolicySummary[];
}

export interface AuditLogSummary {
  id: string;
  timestamp: string;
  actor: 'agent' | 'owner' | 'system' | 'ai';
  event: string;
  requestId: string | null;
  payload: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}

export interface AuditLogResponse {
  items: AuditLogSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApprovePaymentResponse {
  success: boolean;
  status: string;
  captureId?: string;
  orderId?: string;
  warning?: string;
}

export interface VoidPaymentResponse {
  success: boolean;
  status: string;
  remoteVoidStatus?: 'CONFIRMED' | 'PENDING' | 'FAILED';
  message?: string;
}

export interface PaymentTimelineItem {
  id: string;
  actor: 'agent' | 'owner' | 'system' | 'ai';
  event: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface PaymentLedgerItem {
  id: string;
  kind: 'RESERVE' | 'SPEND' | 'RELEASE';
  amountMinor: number;
  amountDecimal: string;
  currency: string;
  createdAt: string;
}

export interface PaymentApprovalItem {
  id: string;
  action: 'APPROVE' | 'VOID';
  expiresAt: string;
  usedAt: string | null;
  channel: string;
  createdAt: string;
}

export interface PaymentRequestDetail {
  id: string;
  agent: {
    id: string;
    name: string;
  };
  vendor: {
    id: string;
    name: string;
  };
  amount: {
    amountMinor: number;
    amountDecimal: string;
    currency: string;
  };
  purpose: string;
  category: string | null;
  sourceContextExcerpt: string | null;
  status: string;
  decision: string | null;
  reasons: string[];
  policyVersionId: string | null;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  remoteVoidStatus: 'PENDING' | 'CONFIRMED' | 'FAILED' | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: PaymentTimelineItem[];
  ledger: PaymentLedgerItem[];
  approvals: PaymentApprovalItem[];
}

