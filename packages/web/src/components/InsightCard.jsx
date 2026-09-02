/** Presentation for one AI insight. */

import { formatCurrency } from '@subtrack/shared';
import { Icon } from './Icon.jsx';
import { Button } from './ui.jsx';

/** Icon and tint per insight type. */
const STYLES = {
  savings: { icon: 'scissors', color: 'var(--success)', soft: 'var(--success-soft)' },
  duplicate: { icon: 'copy', color: 'var(--warning)', soft: 'var(--warning-soft)' },
  unused: { icon: 'eye', color: 'var(--danger)', soft: 'var(--danger-soft)' },
  anomaly: { icon: 'alert-triangle', color: 'var(--danger)', soft: 'var(--danger-soft)' },
  forecast: { icon: 'trending-up', color: 'var(--brand)', soft: 'var(--brand-soft)' },
  trend: { icon: 'activity', color: 'var(--info)', soft: 'var(--info-soft)' },
  price_increase: { icon: 'arrow-up', color: 'var(--danger)', soft: 'var(--danger-soft)' },
  bundle: { icon: 'layers', color: 'var(--accent-violet)', soft: 'var(--brand-soft)' },
  renewal: { icon: 'clock', color: 'var(--warning)', soft: 'var(--warning-soft)' },
  summary: { icon: 'info', color: 'var(--brand)', soft: 'var(--brand-soft)' },
  benchmark: { icon: 'users', color: 'var(--info)', soft: 'var(--info-soft)' },
  recommendation: { icon: 'sparkles', color: 'var(--brand)', soft: 'var(--brand-soft)' },
};

const TYPE_LABELS = {
  savings: 'Saving',
  duplicate: 'Overlap',
  unused: 'Unused',
  anomaly: 'Unusual',
  forecast: 'Forecast',
  trend: 'Trend',
  price_increase: 'Price rise',
  bundle: 'Bundle',
  renewal: 'Renewal',
  summary: 'Summary',
  benchmark: 'Benchmark',
  recommendation: 'Suggestion',
};

export function InsightCard({ insight, currency = 'USD', onDismiss, onAction }) {
  const style = STYLES[insight.insight_type] ?? STYLES.summary;
  const savings = insight.potential_savings ? Number(insight.potential_savings) : 0;

  return (
    <article className="insight" data-severity={insight.severity}>
      <div className="insight-icon" style={{ background: style.soft, color: style.color }}>
        <Icon name={style.icon} size={18} />
      </div>

      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row gap-2 wrap" style={{ marginBottom: 2 }}>
          <span className="badge badge-neutral">{TYPE_LABELS[insight.insight_type] ?? insight.insight_type}</span>
          {insight.severity === 'high' ? <span className="badge badge-danger">Act now</span> : null}
          {/* Say plainly whether Claude wrote this or the rules did. */}
          {insight.model && insight.model !== 'heuristic' ? (
            <span className="badge badge-brand" title={`Written by ${insight.model}`}>
              <Icon name="sparkles" size={10} /> AI
            </span>
          ) : null}
        </div>

        <h4 className="insight-title">{insight.title}</h4>
        <p className="insight-body">{insight.content}</p>

        {savings > 0 ? (
          <div className="row gap-2" style={{ marginTop: 'var(--space-3)' }}>
            <Icon name="trending-down" size={14} style={{ color: 'var(--success)' }} />
            <span className="small">
              Potential saving{' '}
              <span className="insight-savings">{formatCurrency(savings, currency)}/month</span>
              <span className="muted"> ({formatCurrency(savings * 12, currency)}/year)</span>
            </span>
          </div>
        ) : null}

        {(onAction || onDismiss) ? (
          <div className="row gap-2 wrap" style={{ marginTop: 'var(--space-3)' }}>
            {onAction && insight.related_subscription_ids?.length ? (
              <Button
                variant="soft"
                size="sm"
                iconRight="chevron-right"
                onClick={() => onAction(insight)}
              >
                Review
              </Button>
            ) : null}
            {onDismiss ? (
              <Button variant="ghost" size="sm" onClick={() => onDismiss(insight)}>
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default InsightCard;
