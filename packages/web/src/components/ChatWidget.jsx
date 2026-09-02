/**
 * Floating AI assistant.
 *
 * Shares its transcript with the full-page Assistant view through the
 * session id, so a conversation started in the widget can be continued
 * there and vice versa.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { Button } from './ui.jsx';
import { VoiceInput } from './VoiceInput.jsx';
import { api } from '../lib/api.js';
import { useLocalStorage } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

const OPENERS = [
  'How much do I spend on streaming?',
  'What am I not using?',
  'Where can I save money?',
  'What renews this week?',
];

/**
 * The conversation transcript plus the send/confirm logic.
 * Extracted so the widget and the full-page view render the same thing.
 */
export function useAssistant() {
  const toast = useToast();
  const [sessionId, setSessionId] = useLocalStorage('subtrack.chatSession', null);
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(null);
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Replay the stored conversation so the assistant has continuity across
  // reloads and across the two entry points.
  useEffect(() => {
    if (!sessionId || loaded) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { messages: history } = await api.ai.chatHistory(sessionId);
        if (!cancelled) {
          setMessages(history.map((row) => ({ sender: row.sender, text: row.message, id: row.id })));
        }
      } catch {
        // A session that no longer exists just starts a fresh one.
        if (!cancelled) setSessionId(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const send = useCallback(
    async (text) => {
      const message = text.trim();
      if (!message || sending) return;

      // Optimistic: the user's own words appear immediately.
      setMessages((current) => [...current, { sender: 'user', text: message, id: `local-${Date.now()}` }]);
      setSending(true);
      setPending(null);

      try {
        const response = await api.ai.chat(message, sessionId ?? undefined);
        if (response.sessionId !== sessionId) setSessionId(response.sessionId);
        setMessages((current) => [
          ...current,
          { sender: 'assistant', text: response.reply, id: `reply-${Date.now()}`, source: response.source },
        ]);

        const confirmation = response.actions?.find((action) => action.type === 'pending_confirmation');
        if (confirmation) setPending(confirmation.action);

        // Anything that changed the data should refresh the page behind us.
        if (response.actions?.some((action) =>
          ['subscription_created', 'subscription_updated', 'usage_recorded'].includes(action.type))) {
          window.dispatchEvent(new CustomEvent('subtrack:data-changed'));
        }
        return response;
      } catch (error) {
        setMessages((current) => [
          ...current,
          {
            sender: 'assistant',
            text: error.status === 429
              ? error.message
              : 'Something went wrong reaching the assistant. Please try again.',
            id: `error-${Date.now()}`,
            error: true,
          },
        ]);
        return undefined;
      } finally {
        setSending(false);
      }
    },
    [sessionId, sending, setSessionId],
  );

  const confirm = useCallback(async () => {
    if (!pending) return;
    try {
      const result = await api.ai.confirm({ type: pending.type, subscriptionId: pending.subscriptionId });
      toast.success(`${result.subscription.name} cancelled — saving $${result.monthlySaving}/month.`);
      setMessages((current) => [
        ...current,
        { sender: 'assistant', text: `Done. ${result.subscription.name} is marked cancelled.`, id: `confirm-${Date.now()}` },
      ]);
      window.dispatchEvent(new CustomEvent('subtrack:data-changed'));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setPending(null);
    }
  }, [pending, toast]);

  const reset = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setPending(null);
  }, [setSessionId]);

  return { messages, send, sending, pending, confirm, dismissPending: () => setPending(null), reset, loaded };
}

/** Message list + composer, shared by the widget and the full page. */
export function ChatTranscript({ assistant, emptyHint = true, style }) {
  const { messages, send, sending, pending, confirm, dismissPending } = assistant;
  const [draft, setDraft] = useState('');
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const toast = useToast();

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, sending, pending]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await send(text);
    inputRef.current?.focus();
  };

  const onKeyDown = (event) => {
    // Enter sends, Shift+Enter makes a new line.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <>
      <div className="chat-log" ref={logRef} style={style}>
        {messages.length === 0 && emptyHint ? (
          <div className="stack gap-4" style={{ margin: 'auto 0', textAlign: 'center' }}>
            <div className="empty-art" style={{ margin: '0 auto' }}>
              <Icon name="sparkles" size={26} />
            </div>
            <div>
              <strong>Ask me about your subscriptions</strong>
              <p className="small muted" style={{ marginTop: 6 }}>
                Describe a new subscription in plain English and I will add it, or ask
                what you spend and where you could save.
              </p>
            </div>
            <div className="suggestions" style={{ justifyContent: 'center' }}>
              {OPENERS.map((opener) => (
                <button key={opener} type="button" className="suggestion" onClick={() => send(opener)}>
                  {opener}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`bubble bubble-${message.sender === 'user' ? 'user' : 'assistant'}`}
            style={message.error ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}
          >
            {message.text}
          </div>
        ))}

        {sending ? (
          <div className="bubble bubble-assistant" style={{ padding: 0 }}>
            <div className="typing" aria-label="Assistant is typing">
              <span /><span /><span />
            </div>
          </div>
        ) : null}

        {/* A cancellation the assistant proposed. The model cannot perform
            it; this button is the only path. */}
        {pending ? (
          <div className="card animate-pop" style={{ borderColor: 'var(--warning)', padding: 'var(--space-4)' }}>
            <div className="row gap-2" style={{ marginBottom: 'var(--space-2)' }}>
              <Icon name="alert-triangle" size={15} style={{ color: 'var(--warning)' }} />
              <strong className="small">Confirm cancellation</strong>
            </div>
            <p className="small secondary">
              Mark <strong>{pending.name}</strong> as cancelled? That saves{' '}
              <strong>${pending.monthlySaving}/month</strong> (${pending.yearlySaving}/year).
            </p>
            <div className="row gap-2" style={{ marginTop: 'var(--space-3)' }}>
              <Button variant="primary" size="sm" onClick={confirm}>Yes, cancel it</Button>
              <Button size="sm" onClick={dismissPending}>Keep it</Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="chat-input-row">
        <VoiceInput
          onTranscript={(text, { final }) => {
            setDraft(text);
            // A final result means the user stopped talking; sending
            // automatically is what makes voice feel hands-free.
            if (final && text.trim()) {
              setDraft('');
              send(text);
            }
          }}
          onError={(message) => toast.error(message)}
          disabled={sending}
        />
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={1}
          value={draft}
          placeholder="Ask anything, or describe a subscription…"
          onChange={(event) => {
            setDraft(event.target.value);
            // Grow with the content up to the CSS max-height.
            event.target.style.height = 'auto';
            event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={onKeyDown}
          disabled={sending}
          aria-label="Message the assistant"
        />
        <Button
          variant="primary"
          onClick={submit}
          disabled={!draft.trim() || sending}
          aria-label="Send message"
          style={{ width: 40, height: 40, padding: 0 }}
        >
          <Icon name="send" size={16} />
        </Button>
      </div>
    </>
  );
}

/** The floating widget itself. */
export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const assistant = useAssistant();

  return (
    <>
      {!open ? (
        <button
          type="button"
          className="chat-fab"
          onClick={() => setOpen(true)}
          aria-label="Open the AI assistant"
        >
          <Icon name="sparkles" size={22} />
        </button>
      ) : (
        <div className="chat-panel" role="dialog" aria-label="AI assistant">
          <div className="chat-header">
            <span className="sidebar-logo" style={{ width: 30, height: 30 }}>
              <Icon name="sparkles" size={15} />
            </span>
            <div className="grow">
              <strong className="small">SubTrack Assistant</strong>
              <div className="tiny muted">Ask, add, or find savings</div>
            </div>
            <Button variant="ghost" size="sm" onClick={assistant.reset} title="Start a new conversation">
              <Icon name="refresh" size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} aria-label="Close assistant">
              <Icon name="x" size={16} />
            </Button>
          </div>
          <ChatTranscript assistant={assistant} />
        </div>
      )}
    </>
  );
}

export default ChatWidget;
