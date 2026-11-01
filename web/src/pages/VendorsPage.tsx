import { useEffect, useState } from 'react';
import { Building2, Plus, AlertTriangle, CheckCircle2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { LoadingSpinner } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { apiClient } from '../lib/api';
import { formatDateTime } from '../lib/formatters';
import type { VendorsResponse, VendorSummary, CreateVendorResponse } from '../types/api';

export function VendorsPage() {
  const [vendors, setVendors] = useState<VendorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Form Fields
  const [vendorId, setVendorId] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'UNVERIFIED' | 'BLOCKED'>('ACTIVE');
  const [categoriesInput, setCategoriesInput] = useState('api, cloud, devtools');
  const [currenciesInput, setCurrenciesInput] = useState('USD');

  const fetchVendors = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.get<VendorsResponse>('/api/vendors');
      setVendors(res.vendors || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to retrieve vendor registry');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVendors();
  }, []);

  const handleOpenModal = () => {
    setVendorId('');
    setName('');
    setStatus('ACTIVE');
    setCategoriesInput('api, cloud, devtools');
    setCurrenciesInput('USD');
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedId = vendorId.trim();
    const trimmedName = name.trim();

    if (!trimmedId || !/^[a-zA-Z0-9_-]{2,64}$/.test(trimmedId)) {
      setFormError('Vendor ID must be 2-64 characters containing letters, numbers, dashes, or underscores.');
      return;
    }

    if (!trimmedName || trimmedName.length > 120) {
      setFormError('Display name is required and must not exceed 120 characters.');
      return;
    }

    const categories = categoriesInput
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);

    if (categories.length === 0) {
      setFormError('Please provide at least one category.');
      return;
    }

    const currencies = currenciesInput
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);

    if (currencies.length === 0 || currencies.some((c) => !/^[A-Z]{3}$/.test(c))) {
      setFormError('Currencies must be 3-letter uppercase codes (e.g. USD, EUR).');
      return;
    }

    try {
      setSubmitting(true);
      // Security invariant: never expose or transmit connector_key or secrets in frontend
      await apiClient.post<CreateVendorResponse>('/api/vendors', {
        id: trimmedId,
        name: trimmedName,
        status,
        categories,
        currencies,
      });

      setIsModalOpen(false);
      setSuccessMessage(`Vendor '${trimmedName}' successfully registered.`);
      setTimeout(() => setSuccessMessage(null), 4000);
      await fetchVendors();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to register vendor.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">Approved Vendors</h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Registered merchants, category allowlists, and vaulted PayPal tokens
          </p>
        </div>
        <Button onClick={handleOpenModal} size="sm" className="self-start sm:self-auto">
          <Plus className="mr-1.5 h-4 w-4" />
          Register Vendor
        </Button>
      </div>

      {/* Success Notification */}
      {successMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--accent-sage)]/30 bg-[var(--accent-sage)]/10 p-3 text-xs text-[var(--accent-sage)]">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <Card className="p-6">
          <EmptyState
            icon={AlertTriangle}
            title="Failed to load vendors"
            description={error}
            action={
              <Button variant="secondary" size="sm" onClick={fetchVendors}>
                Retry
              </Button>
            }
          />
        </Card>
      )}

      {/* Vendor Table */}
      {!error && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Categories</TableHead>
                <TableHead>Currencies</TableHead>
                <TableHead>PayPal Vault</TableHead>
                <TableHead className="text-right">Registered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-12 text-center">
                    <EmptyState
                      icon={Building2}
                      title="No Vendors Registered"
                      description="Register your first approved merchant to allow AI agents to request payments."
                      action={
                        <Button size="sm" onClick={handleOpenModal}>
                          <Plus className="mr-1.5 h-4 w-4" />
                          Register Vendor
                        </Button>
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                vendors.map((vendor) => (
                  <TableRow key={vendor.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--text-primary)]">{vendor.name}</span>
                        <span className="font-mono text-xs text-[var(--text-secondary)]">{vendor.id}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge status={vendor.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {vendor.categories.map((cat) => (
                          <span
                            key={cat}
                            className="rounded-md border border-[var(--border-color)] bg-[var(--elevated-bg)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]"
                          >
                            {cat}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {vendor.currencies.map((curr) => (
                          <span
                            key={curr}
                            className="rounded-md border border-[var(--border-color)] bg-[var(--card-bg)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--text-primary)]"
                          >
                            {curr}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {vendor.hasVaultToken ? (
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-[var(--accent-sage)]">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Vaulted
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-[var(--text-secondary)]">
                          <ShieldAlert className="h-3.5 w-3.5" />
                          No Token
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-[var(--text-secondary)]">
                      {formatDateTime(vendor.createdAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Register Vendor Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => !submitting && setIsModalOpen(false)}
        title="Register Approved Vendor"
        description="Add a merchant to the firewall registry for deterministic agent payment authorization."
        maxWidth="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {formError && (
            <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3 text-xs text-[var(--status-error)]">
              {formError}
            </div>
          )}

          <Input
            label="Vendor Identifier"
            placeholder="e.g. anthropic, openai, aws"
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            hint="2-64 alphanumeric characters, dashes, or underscores."
            required
            autoFocus
          />

          <Input
            label="Display Name"
            placeholder="e.g. Anthropic Claude API"
            value={name}
            onChange={(e) => setName(e.target.value)}
            hint="Human-readable merchant name (max 120 characters)."
            required
          />

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--text-secondary)]">Vendor Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as 'ACTIVE' | 'UNVERIFIED' | 'BLOCKED')}
              className="flex h-10 w-full rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-sage)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-sage)]"
            >
              <option value="ACTIVE">ACTIVE (Authorized for auto-approve ceilings)</option>
              <option value="UNVERIFIED">UNVERIFIED (Triggers HOLD for manual owner approval)</option>
              <option value="BLOCKED">BLOCKED (Immediately DENIED by deterministic engine)</option>
            </select>
          </div>

          <Input
            label="Categories"
            placeholder="api, cloud, devtools"
            value={categoriesInput}
            onChange={(e) => setCategoriesInput(e.target.value)}
            hint="Comma-separated category tags."
            required
          />

          <Input
            label="Supported Currencies"
            placeholder="USD, EUR, GBP"
            value={currenciesInput}
            onChange={(e) => setCurrenciesInput(e.target.value)}
            hint="Comma-separated 3-letter uppercase currency codes."
            required
          />

          <div className="flex justify-end gap-2 pt-4 border-t border-[var(--border-color)]">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setIsModalOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" isLoading={submitting}>
              Register Vendor
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
