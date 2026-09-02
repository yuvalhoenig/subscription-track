/**
 * Add / edit subscription dialog.
 *
 * Two ways in: fill the form, or paste a sentence ("Netflix $15.99/month")
 * and let the AI extractor fill it for you. Receipt images go through the
 * same path via OCR.
 */

import { useEffect, useState } from 'react';
import { BILLING_CYCLES, CYCLE_LABELS, monthlyCost, yearlyCost, today, formatCurrency } from '@subtrack/shared';
import { Modal, Button, Field, Input, Select, Textarea, Alert } from './ui.jsx';
import { Icon } from './Icon.jsx';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';

const BLANK = {
  name: '',
  cost: '',
  currency: 'USD',
  billingCycle: 'monthly',
  categoryId: '',
  renewalDate: today(),
  status: 'active',
  trialEndsAt: '',
  url: '',
  notes: '',
  reminderDaysBefore: 3,
};

/** Map a server subscription row onto form state. */
function toFormState(subscription) {
  if (!subscription) return { ...BLANK };
  return {
    name: subscription.name ?? '',
    cost: String(subscription.cost ?? ''),
    currency: subscription.currency ?? 'USD',
    billingCycle: subscription.billing_cycle ?? 'monthly',
    categoryId: subscription.category_id ?? '',
    renewalDate: subscription.renewal_date ?? today(),
    status: subscription.status ?? 'active',
    trialEndsAt: subscription.trial_ends_at ?? '',
    url: subscription.url ?? '',
    notes: subscription.notes ?? '',
    reminderDaysBefore: subscription.reminder_days_before ?? 3,
  };
}

export function SubscriptionForm({ open, onClose, onSaved, subscription, categories = [] }) {
  const toast = useToast();
  const isEdit = Boolean(subscription);
  const [form, setForm] = useState(() => toFormState(subscription));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [smartText, setSmartText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [showSmart, setShowSmart] = useState(false);

  // Re-seed whenever the dialog opens for a different subscription.
  useEffect(() => {
    if (open) {
      setForm(toFormState(subscription));
      setErrors({});
      setSmartText('');
      setShowSmart(false);
    }
  }, [open, subscription]);

  const set = (key) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((current) => ({ ...current, [key]: value }));
    // Clear the field's error as soon as the user edits it.
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  };

  /** Let the AI fill the form from free text. */
  const runExtraction = async () => {
    if (!smartText.trim()) return;
    setExtracting(true);
    try {
      const { draft, missing } = await api.ai.extract(smartText);
      const matchedCategory = draft.category
        ? categories.find((category) => category.name.toLowerCase() === draft.category.toLowerCase())
        : null;

      setForm((current) => ({
        ...current,
        name: draft.name ?? current.name,
        cost: draft.cost != null ? String(draft.cost) : current.cost,
        currency: draft.currency ?? current.currency,
        billingCycle: draft.billingCycle ?? current.billingCycle,
        renewalDate: draft.renewalDate ?? current.renewalDate,
        status: draft.status ?? current.status,
        trialEndsAt: draft.trialEndsAt ?? current.trialEndsAt,
        categoryId: matchedCategory?.id ?? current.categoryId,
      }));

      if (missing.length) {
        toast.info(`Filled in what I could — still need ${missing.join(' and ')}.`);
      } else {
        toast.success('Details extracted. Check them and save.');
      }
      setShowSmart(false);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setExtracting(false);
    }
  };

  /** OCR a receipt image and fill the form from it. */
  const onReceiptPicked = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setExtracting(true);
    try {
      const { draft, error } = await api.ai.receiptImage(file);
      if (error || !draft) {
        toast.error(error ?? 'Could not read that receipt.');
        return;
      }
      const matchedCategory = draft.category
        ? categories.find((category) => category.name.toLowerCase() === draft.category.toLowerCase())
        : null;
      setForm((current) => ({
        ...current,
        name: draft.name ?? current.name,
        cost: draft.cost != null ? String(draft.cost) : current.cost,
        currency: draft.currency ?? current.currency,
        billingCycle: draft.billingCycle ?? current.billingCycle,
        renewalDate: draft.renewalDate ?? current.renewalDate,
        categoryId: matchedCategory?.id ?? current.categoryId,
      }));
      toast.success('Receipt read. Check the details and save.');
      setShowSmart(false);
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setExtracting(false);
      // Allow picking the same file again.
      event.target.value = '';
    }
  };

  /** Client-side validation mirrors the server's rules. */
  const validate = () => {
    const found = {};
    if (!form.name.trim()) found.name = 'Give the subscription a name';
    const cost = Number.parseFloat(form.cost);
    if (!Number.isFinite(cost)) found.cost = 'Enter an amount';
    else if (cost < 0) found.cost = 'Cost cannot be negative';
    if (!form.renewalDate) found.renewalDate = 'Pick the next renewal date';
    if (form.status === 'trial' && !form.trialEndsAt && !form.renewalDate) {
      found.trialEndsAt = 'A trial needs an end date';
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        cost: Number.parseFloat(form.cost),
        currency: form.currency,
        billingCycle: form.billingCycle,
        renewalDate: form.renewalDate,
        status: form.status,
        reminderDaysBefore: Number(form.reminderDaysBefore),
      };
      // Only send optional fields that have a value: the server's strict
      // schemas reject empty strings where a date or URL is expected.
      if (form.categoryId) payload.categoryId = form.categoryId;
      if (form.trialEndsAt) payload.trialEndsAt = form.trialEndsAt;
      if (form.url.trim()) payload.url = form.url.trim();
      if (form.notes.trim()) payload.notes = form.notes.trim();

      const result = isEdit
        ? await api.subscriptions.update(subscription.id, payload)
        : await api.subscriptions.create(payload);

      toast.success(isEdit ? `${payload.name} updated.` : `${payload.name} added.`);
      onSaved?.(result.subscription);
      onClose();
    } catch (error) {
      if (error.isValidationError) {
        setErrors(error.details);
        toast.error('Please fix the highlighted fields.');
      } else {
        toast.error(error.message);
      }
    } finally {
      setSaving(false);
    }
  };

  // Live preview of the normalised cost, so the user can sanity-check a
  // yearly plan against their monthly budget while typing.
  const parsedCost = Number.parseFloat(form.cost);
  const preview = Number.isFinite(parsedCost) && parsedCost >= 0
    ? {
        monthly: monthlyCost(parsedCost, form.billingCycle),
        yearly: yearlyCost(parsedCost, form.billingCycle),
      }
    : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${subscription.name}` : 'Add a subscription'}
      subtitle={isEdit ? undefined : 'Type it in, describe it in a sentence, or scan a receipt.'}
      footer={(
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={saving}>
            {isEdit ? 'Save changes' : 'Add subscription'}
          </Button>
        </>
      )}
    >
      <div className="stack gap-4">
        {!isEdit ? (
          showSmart ? (
            <div className="card" style={{ background: 'var(--gradient-brand-soft)', borderColor: 'var(--brand-300)' }}>
              <div className="row gap-2" style={{ marginBottom: 'var(--space-3)' }}>
                <Icon name="sparkles" size={15} style={{ color: 'var(--brand)' }} />
                <strong className="small">Describe it and I will fill the form</strong>
              </div>
              <Textarea
                value={smartText}
                onChange={(event) => setSmartText(event.target.value)}
                placeholder="e.g. I just got Netflix for $15.99 a month, renews on the 14th"
                rows={2}
                style={{ minHeight: 64 }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) runExtraction();
                }}
              />
              <div className="row gap-2 wrap" style={{ marginTop: 'var(--space-3)' }}>
                <Button variant="primary" size="sm" icon="sparkles" onClick={runExtraction} loading={extracting}>
                  Extract details
                </Button>
                <label className="btn btn-secondary btn-sm" style={{ margin: 0 }}>
                  <Icon name="receipt" size={14} />
                  Scan a receipt
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={onReceiptPicked}
                    disabled={extracting}
                  />
                </label>
                <Button variant="ghost" size="sm" onClick={() => setShowSmart(false)}>
                  Enter manually
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="soft" icon="sparkles" onClick={() => setShowSmart(true)} block>
              Add with AI instead
            </Button>
          )
        ) : null}

        <Field label="Service name" error={errors.name} required htmlFor="sub-name">
          <Input
            id="sub-name"
            value={form.name}
            onChange={set('name')}
            placeholder="Netflix"
            error={errors.name}
            autoComplete="off"
          />
        </Field>

        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
          <Field label="Cost" error={errors.cost} required htmlFor="sub-cost">
            <Input
              id="sub-cost"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={form.cost}
              onChange={set('cost')}
              placeholder="15.99"
              error={errors.cost}
              prefix={<Icon name="dollar-sign" size={14} />}
            />
          </Field>

          <Field label="Billing cycle" htmlFor="sub-cycle">
            <Select
              id="sub-cycle"
              value={form.billingCycle}
              onChange={set('billingCycle')}
              options={BILLING_CYCLES.map((cycle) => ({ value: cycle, label: CYCLE_LABELS[cycle] }))}
            />
          </Field>
        </div>

        {preview ? (
          <div
            className="row gap-4 small"
            style={{
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--surface-sunken)',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
            }}
          >
            <span className="muted">Works out to</span>
            <strong className="nums">{formatCurrency(preview.monthly, form.currency)}/month</strong>
            <span className="muted">·</span>
            <strong className="nums">{formatCurrency(preview.yearly, form.currency)}/year</strong>
          </div>
        ) : null}

        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
          <Field label="Category" hint={!form.categoryId ? 'Left blank, the AI picks one' : undefined} htmlFor="sub-category">
            <Select
              id="sub-category"
              value={form.categoryId}
              onChange={set('categoryId')}
              placeholder="Auto-categorise"
              options={categories.map((category) => ({ value: category.id, label: category.name }))}
            />
          </Field>

          <Field label="Status" htmlFor="sub-status">
            <Select
              id="sub-status"
              value={form.status}
              onChange={set('status')}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'trial', label: 'Free trial' },
                { value: 'paused', label: 'Paused' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />
          </Field>
        </div>

        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
          <Field label="Next renewal" error={errors.renewalDate} required htmlFor="sub-renewal">
            <Input
              id="sub-renewal"
              type="date"
              value={form.renewalDate}
              onChange={set('renewalDate')}
              error={errors.renewalDate}
            />
          </Field>

          {form.status === 'trial' ? (
            <Field label="Trial ends" error={errors.trialEndsAt} htmlFor="sub-trial">
              <Input
                id="sub-trial"
                type="date"
                value={form.trialEndsAt}
                onChange={set('trialEndsAt')}
                error={errors.trialEndsAt}
              />
            </Field>
          ) : (
            <Field label="Remind me" hint="Days before renewal" htmlFor="sub-reminder">
              <Select
                id="sub-reminder"
                value={String(form.reminderDaysBefore)}
                onChange={set('reminderDaysBefore')}
                options={[
                  { value: '0', label: 'On the day' },
                  { value: '1', label: '1 day before' },
                  { value: '3', label: '3 days before' },
                  { value: '7', label: '1 week before' },
                  { value: '14', label: '2 weeks before' },
                ]}
              />
            </Field>
          )}
        </div>

        {form.status === 'trial' ? (
          <Alert tone="info">
            Trials are excluded from your current spend but shown separately, so you can
            see what next month looks like if they convert.
          </Alert>
        ) : null}

        <details>
          <summary className="small secondary" style={{ cursor: 'pointer', userSelect: 'none' }}>
            More details
          </summary>
          <div className="stack gap-4" style={{ marginTop: 'var(--space-4)' }}>
            <Field label="Website" error={errors.url} htmlFor="sub-url">
              <Input
                id="sub-url"
                type="url"
                value={form.url}
                onChange={set('url')}
                placeholder="https://netflix.com/account"
                error={errors.url}
              />
            </Field>
            <Field label="Notes" htmlFor="sub-notes">
              <Textarea
                id="sub-notes"
                value={form.notes}
                onChange={set('notes')}
                placeholder="Plan details, who shares it, how to cancel…"
                rows={3}
              />
            </Field>
          </div>
        </details>
      </div>
    </Modal>
  );
}

export default SubscriptionForm;
