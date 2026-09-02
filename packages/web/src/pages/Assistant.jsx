/** Full-page assistant: the chat widget with room to breathe. */

import { useState } from 'react';
import { AppShell } from '../components/AppShell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Button, Empty, Alert } from '../components/ui.jsx';
import { useAssistant, ChatTranscript } from '../components/ChatWidget.jsx';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

const EXAMPLES = [
  { icon: 'plus', text: 'I just got Netflix for $15.99 a month' },
  { icon: 'dollar-sign', text: 'How much do I spend on streaming?' },
  { icon: 'eye', text: 'What subscriptions am I not using?' },
  { icon: 'scissors', text: 'Where can I save money?' },
  { icon: 'calendar', text: 'What renews in the next two weeks?' },
  { icon: 'trending-up', text: 'What will I spend next month?' },
];

export function AssistantPage() {
  const assistant = useAssistant();
  const toast = useToast();
  const aiStatus = useAsync(() => api.ai.status(), []);
  const [scanning, setScanning] = useState(false);

  /**
   * Import from a pasted e-mail. Nothing is created automatically: the
   * scan returns candidates with duplicate flags, and the user picks.
   */
  const [emailText, setEmailText] = useState('');
  const [candidates, setCandidates] = useState(null);

  const scanEmail = async () => {
    if (!emailText.trim()) return;
    setScanning(true);
    try {
      const result = await api.ai.scanEmails([{
        subject: 'Pasted message',
        from: 'unknown@example.com',
        body: emailText,
      }]);
      setCandidates(result.candidates);
      if (!result.candidates.length) {
        toast.info('That did not look like a subscription confirmation.');
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setScanning(false);
    }
  };

  const importCandidate = async (candidate) => {
    try {
      await api.subscriptions.create({
        name: candidate.draft.name,
        cost: candidate.draft.cost,
        currency: candidate.draft.currency,
        billingCycle: candidate.draft.billingCycle,
        renewalDate: candidate.draft.renewalDate ?? undefined,
        status: candidate.draft.status,
      });
      toast.success(`${candidate.draft.name} added.`);
      setCandidates((current) => current.filter((item) => item !== candidate));
      window.dispatchEvent(new CustomEvent('subtrack:data-changed'));
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <AppShell
      title="Assistant"
      actions={(
        <Button variant="secondary" icon="refresh" onClick={assistant.reset}>
          <span className="desktop-only">New conversation</span>
        </Button>
      )}
    >
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--space-5)' }}>
        {aiStatus.data && aiStatus.data.mode === 'heuristic' ? (
          <Alert tone="info">
            Running in heuristic mode: the assistant understands adding subscriptions
            and the common spending questions, using rules rather than a language model.
            Set <code>ANTHROPIC_API_KEY</code> for full conversational ability.
          </Alert>
        ) : null}

        <div
          className="card card-flush"
          style={{ display: 'flex', flexDirection: 'column', height: 'min(660px, calc(100dvh - 220px))' }}
        >
          <div className="chat-header">
            <span className="sidebar-logo" style={{ width: 32, height: 32 }}>
              <Icon name="sparkles" size={16} />
            </span>
            <div className="grow">
              <strong className="small">SubTrack Assistant</strong>
              <div className="tiny muted">
                {aiStatus.data?.mode === 'claude'
                  ? `Powered by ${aiStatus.data.models?.smart ?? 'Claude'}`
                  : 'Rule-based mode'}
              </div>
            </div>
          </div>
          <ChatTranscript assistant={assistant} />
        </div>

        {assistant.messages.length === 0 ? (
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Things to try</div>
                <div className="card-subtitle">Speak or type — the assistant reads plain English</div>
              </div>
            </div>
            <div className="grid grid-3">
              {EXAMPLES.map((example) => (
                <button
                  key={example.text}
                  type="button"
                  className="card card-hover row gap-3"
                  style={{ textAlign: 'left', padding: 'var(--space-4)' }}
                  onClick={() => assistant.send(example.text)}
                >
                  <Icon name={example.icon} size={16} style={{ color: 'var(--brand)' }} />
                  <span className="small">{example.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* ── Import from a confirmation e-mail ── */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title row gap-2">
                <Icon name="mail" size={16} style={{ color: 'var(--brand)' }} />
                Import from an e-mail
              </div>
              <div className="card-subtitle">
                Paste a subscription confirmation and SubTrack will read the details out of it
              </div>
            </div>
          </div>

          <textarea
            className="textarea"
            value={emailText}
            onChange={(event) => setEmailText(event.target.value)}
            placeholder={'Paste the whole e-mail here — subject line and body.\n\ne.g. "Your Spotify Premium receipt … Total $11.99 … renews on 04/12/2026"'}
            rows={5}
          />
          <div className="row gap-2 wrap" style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="primary" size="sm" icon="search" onClick={scanEmail} loading={scanning}>
              Scan for subscriptions
            </Button>
            {emailText ? (
              <Button variant="ghost" size="sm" onClick={() => { setEmailText(''); setCandidates(null); }}>
                Clear
              </Button>
            ) : null}
          </div>

          {candidates?.length ? (
            <div className="stack gap-3" style={{ marginTop: 'var(--space-5)' }}>
              {candidates.map((candidate, index) => (
                <div
                  className="card row gap-3 wrap"
                  key={`${candidate.draft.name}-${index}`}
                  style={{ background: 'var(--surface-sunken)' }}
                >
                  <div className="grow">
                    <div className="row gap-2 wrap">
                      <strong className="small">{candidate.draft.name ?? 'Unknown service'}</strong>
                      {candidate.duplicateOf ? (
                        <span className="badge badge-warning">
                          Already tracked
                        </span>
                      ) : (
                        <span className="badge badge-success">New</span>
                      )}
                      <span className="tiny muted">
                        {Math.round((candidate.confidence ?? 0) * 100)}% confident
                      </span>
                    </div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      {candidate.draft.cost != null ? `$${candidate.draft.cost} ` : 'No price found '}
                      {candidate.draft.billingCycle ?? ''}
                      {candidate.draft.renewalDate ? ` · renews ${candidate.draft.renewalDate}` : ''}
                    </div>
                    {candidate.priceChanged ? (
                      <div className="tiny" style={{ color: 'var(--warning)', marginTop: 4 }}>
                        Price changed: ${candidate.priceChanged.from} → ${candidate.priceChanged.to}
                      </div>
                    ) : null}
                  </div>
                  {candidate.duplicateOf ? (
                    <span className="tiny muted">Skipped to avoid a duplicate</span>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      icon="plus"
                      onClick={() => importCandidate(candidate)}
                      disabled={candidate.missing?.length > 0}
                      title={candidate.missing?.length ? `Missing ${candidate.missing.join(', ')}` : undefined}
                    >
                      Add
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : candidates ? (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Empty
                icon="mail"
                title="No subscription found"
                message="That message did not look like a subscription confirmation or receipt."
              />
            </div>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

export default AssistantPage;
