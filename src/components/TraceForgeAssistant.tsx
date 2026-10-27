import { useEffect, useRef, useState } from 'react';
import { SUGGESTED_QUESTIONS } from '../data/knowledge-base';
import type { AssistantSessionContext } from '../lib/rag-engine';

const WELCOME_MESSAGE =
  'Hi! I can help you explore TraceForge, troubleshoot circuits, understand measurements, or answer questions. What would you like to know?';

interface ChatSource {
  entryId: string;
  title: string;
  excerpt: string;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  sources?: ChatSource[];
  pending?: boolean;
}

interface ChatPayload {
  reply?: string;
  sources?: ChatSource[];
  error?: string;
}

/**
 * Floating TraceForge Assistant widget (RAG-first, $0.00 knowledge answers).
 *
 * Chicago-Renovator-style floating launcher + card panel, adapted to the
 * TraceForge dark workbench aesthetic. Chat state is in-memory only; the
 * server never sees credentials, and the UI never renders developer
 * token/cost/mode strings.
 */
export function TraceForgeAssistant({ sessionContext }: { sessionContext?: AssistantSessionContext }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: 0, role: 'assistant', text: WELCOME_MESSAGE }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const seqRef = useRef(0);
  const idRef = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch a free chat session ticket once (gates paid live calls server-side).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/assistant/session');
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { sessionTicket?: string };
        if (typeof data.sessionTicket === 'string' && !cancelled) setTicket(data.sessionTicket);
      } catch {
        // Ticket fetch is best-effort: chat still works via knowledge answers.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // Escape-to-close.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function clearConversation() {
    abortRef.current?.abort();
    abortRef.current = null;
    pendingRef.current = false;
    setSending(false);
    setMessages([{ id: 0, role: 'assistant', text: WELCOME_MESSAGE }]);
    setInput('');
  }

  async function send(text: string) {
    const trimmed = text.trim();
    // Duplicate-send prevention: ignore empty, overlong, or in-flight sends.
    if (!trimmed || pendingRef.current || trimmed.length > 1000) return;
    pendingRef.current = true;
    setSending(true);
    const seq = (seqRef.current += 1);
    const controller = new AbortController();
    abortRef.current = controller;
    const userMsg: ChatMessage = { id: idRef.current += 1, role: 'user', text: trimmed };
    const pendingMsg: ChatMessage = { id: idRef.current += 1, role: 'assistant', text: 'Thinking…', pending: true };
    const prior = messages;
    setMessages([...prior, userMsg, pendingMsg]);
    setInput('');
    try {
      const history = [...prior, userMsg]
        .filter((m) => !m.pending)
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.text }));
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history,
          sessionContext: sessionContext ?? {},
          ...(ticket ? { sessionTicket: ticket } : {}),
          allowLiveInference: true,
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as ChatPayload;
      // Stale-response protection: only the latest request updates state.
      if (seq !== seqRef.current) return;
      const reply = typeof data.reply === 'string' && data.reply.length > 0
        ? data.reply
        : 'Sorry — I could not answer that just now. Try one of the suggested questions.';
      setMessages((prev) => [...prev.filter((m) => !m.pending), {
        id: idRef.current += 1,
        role: 'assistant',
        text: reply,
        sources: Array.isArray(data.sources) ? data.sources.slice(0, 3) : [],
      }]);
    } catch {
      if (seq !== seqRef.current) return;
      if (controller.signal.aborted) return;
      setMessages((prev) => [...prev.filter((m) => !m.pending), {
        id: idRef.current += 1,
        role: 'assistant',
        text: 'The assistant is unreachable right now. Your bench, measurements, and scoring are unaffected — try again in a moment.',
      }]);
    } finally {
      if (seq === seqRef.current) {
        pendingRef.current = false;
        setSending(false);
        abortRef.current = null;
      }
    }
  }

  if (!open) {
    return (
      <button
        className="tf-assistant-launcher"
        onClick={() => setOpen(true)}
        aria-label="Open TraceForge Assistant"
        title="TraceForge Assistant"
      >
        <img src="/traceforge-icon.png" alt="" aria-hidden="true" />
        <span className="tf-assistant-launcher-dot" aria-hidden="true" />
      </button>
    );
  }

  const showSuggestions = messages.filter((m) => !m.pending).length <= 1;

  return (
    <section className="tf-assistant-panel" aria-label="TraceForge Assistant">
      <header className="tf-assistant-head">
        <span className="tf-assistant-avatar">
          <img src="/traceforge-icon.png" alt="TraceForge Assistant avatar" />
          <span className="tf-assistant-online-dot" aria-label="online" />
        </span>
        <span className="tf-assistant-title">TraceForge Assistant</span>
        <span className="tf-assistant-head-actions">
          <button onClick={clearConversation} title="Clear conversation">Clear</button>
          <button onClick={() => setOpen(false)} aria-label="Close assistant" title="Close">✕</button>
        </span>
      </header>
      <div className="tf-assistant-messages" ref={scrollRef} role="log" aria-live="polite">
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'tf-assistant-bubble user' : 'tf-assistant-bubble assistant'}>
            <p>{m.text}</p>
            {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
              <div className="tf-assistant-sources">
                {m.sources.map((s) => (
                  <span key={s.entryId} className="tf-assistant-source-pill" title={s.excerpt}>{s.title}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {showSuggestions && (
          <div className="tf-assistant-suggestions">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button key={q} onClick={() => void send(q)} disabled={sending}>{q}</button>
            ))}
          </div>
        )}
      </div>
      <form
        className="tf-assistant-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask anything..."
          aria-label="Ask the TraceForge Assistant"
          maxLength={1000}
          disabled={sending}
        />
        <button type="submit" disabled={sending || input.trim().length === 0} aria-label="Send message">Send</button>
      </form>
    </section>
  );
}
