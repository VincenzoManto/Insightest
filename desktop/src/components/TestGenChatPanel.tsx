import React, { useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, ListChecks, MessageCircleQuestion, MessagesSquare, Send, Sparkles, Square, User, X } from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import type { AiChatQuestion, AiChatTurn, AiTestStatus } from '../electron-bridge';
import { t } from '../i18n';
import type { Project, TestSummary } from '../types';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  questions?: AiChatQuestion[];
  plan?: string[];
  created?: string;
}

function Bubble({ msg }: { msg: ChatMessage }): React.ReactElement {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex items-end gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-ink-muted/15 text-ink-secondary' : 'bg-accent text-ink-primary'}`}>
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div
        className={`max-w-[78%] px-3.5 py-2.5 text-[13px] leading-snug shadow-soft ${
          isUser
            ? 'rounded-2xl rounded-br-sm bg-accent text-ink-primary'
            : 'rounded-2xl rounded-bl-sm border border-gridline bg-surface text-ink-secondary'
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{msg.text}</div>
        {msg.created && (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-good/15 px-2.5 py-1 text-[11px] font-semibold text-good">
            <CheckCircle2 size={12} /> {t('Saved as "{name}"', { name: msg.created })}
          </div>
        )}
        {msg.plan && msg.plan.length > 0 && (
          <div className="mt-2 rounded-xl bg-page px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-ink-primary">
              <ListChecks size={12} /> {t('Proposed plan')}
            </div>
            <ol className="list-decimal space-y-0.5 pl-4 text-xs text-ink-secondary">
              {msg.plan.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        )}
        {msg.questions && msg.questions.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {msg.questions.map((q, i) => (
              <div key={i} className="flex gap-2 rounded-xl bg-page px-2.5 py-2">
                {q.screenshot && <img src={q.screenshot} alt="" className="h-16 w-24 flex-shrink-0 rounded-lg border border-gridline object-cover object-top" />}
                <div className="min-w-0 flex-1 text-xs text-ink-secondary">
                  <div className="flex items-center gap-1 font-medium text-ink-primary">
                    <MessageCircleQuestion size={12} /> {t('Question')}
                  </div>
                  {q.text}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TypingIndicator(): React.ReactElement {
  return (
    <div className="flex items-end gap-2">
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent text-ink-primary">
        <Bot size={14} />
      </div>
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-gridline bg-surface px-4 py-3 shadow-soft">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-muted" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
}

/**
 * Project-level chat: lets the user describe many tests one after another in the same
 * conversation. For each one, Claude asks clarifying questions (with screenshots) when needed,
 * proposes a plan for confirmation, then writes the test -- which is saved immediately, so the
 * user can keep going and create 10-20 tests in one sitting without leaving the chat.
 */
export function TestGenChatPanel({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const { api } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AiTestStatus | null>(null);
  const [otherTests, setOtherTests] = useState<TestSummary[]>([]);
  const [createdCount, setCreatedCount] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.insightest.agent.aiStatus().then(setStatus).catch(() => setStatus(null));
    refreshOtherTests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, running]);

  async function refreshOtherTests(): Promise<void> {
    try {
      const res = await api.get<{ tests: TestSummary[] }>(`/projects/${project.id}/tests`);
      setOtherTests(res.tests);
    } catch {
      /* dependsOn resolution is best-effort */
    }
  }

  const ready = !!status?.claude && !!status.insightestMcp;
  const unavailableReason = !status
    ? t('Checking Claude Code and the MCP server…')
    : !status.claude
      ? t('Claude Code not found: install the `claude` CLI and make sure it is on the app PATH.')
      : !status.insightestMcp
        ? t('The "insightest" MCP server is not registered in Claude Code: generate the command from the "API Keys" screen (AI agents (MCP)), run it, then reopen this screen.')
        : null;
  const busy = running || saving;

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || busy || !ready) return;
    const history: AiChatTurn[] = messages.map((msg) => ({ role: msg.role, text: msg.text }));
    setMessages((prev) => [...prev, { role: 'user', text: trimmed }]);
    setInput('');
    setRunning(true);
    setError(null);
    setLines([]);
    const unsubscribe = window.insightest.playwright.onProgress((line) => setLines((prev) => [...prev, line]));
    try {
      const result = await window.insightest.agent.aiChat({
        history,
        instruction: trimmed,
        baseUrl: project.base_url,
        repoPath: project.repo_path,
        projectId: project.id,
      });
      if (result.cancelled) {
        setMessages((prev) => [...prev, { role: 'assistant', text: t('Stopped.') }]);
      } else if (result.status === 'code' && result.code && result.name) {
        setRunning(false);
        await saveTest(result.name, result.code, result.dependsOn, result.message);
      } else if (result.status === 'plan') {
        setMessages((prev) => [...prev, { role: 'assistant', text: result.message || t('Here is the plan:'), plan: result.plan }]);
      } else if (result.status === 'question' && result.questions.length) {
        setMessages((prev) => [...prev, { role: 'assistant', text: result.message || t('I need a bit more detail:'), questions: result.questions }]);
      } else {
        setError(result.message || t('The agent returned no usable answer. See the log below.'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while running the agent'));
    } finally {
      unsubscribe();
      setRunning(false);
    }
  }

  async function saveTest(name: string, code: string, dependsOn: string | null, message?: string): Promise<void> {
    setSaving(true);
    try {
      const prerequisite = dependsOn ? otherTests.find((o) => o.name === dependsOn) : undefined;
      await api.post(`/projects/${project.id}/tests`, {
        name,
        description: null,
        prompt: null,
        playwright_code: code,
        depends_on_test_id: prerequisite?.id ?? null,
      });
      setCreatedCount((n) => n + 1);
      setMessages((prev) => [...prev, { role: 'assistant', text: message || t('Test created.'), created: name }]);
      onCreated();
      await refreshOtherTests();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Error while saving the test'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-primary/45 p-4 backdrop-blur-[2px]">
      <div
        className="flex h-[min(760px,88vh)] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-gridline bg-page shadow-2xl"
        role="dialog"
        aria-label={t('Generate tests with Claude')}
      >
        <header className="flex items-start justify-between gap-4 border-b border-gridline bg-surface px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-accent text-ink-primary">
              <Sparkles size={16} />
            </div>
            <div>
              <div className="text-[15px] font-semibold text-ink-primary">{t('Generate tests with Claude')}</div>
              <div className="text-xs text-ink-muted">{project.name}</div>
            </div>
          </div>
          <button className="secondary icon" onClick={onClose} title={t('Close')}>
            <X size={16} />
          </button>
        </header>

        {createdCount > 0 && (
          <div className="flex items-center gap-2 border-b border-good/20 bg-good/10 px-5 py-1.5 text-xs font-medium text-good">
            <CheckCircle2 size={13} /> {t('{n} test(s) created in this session.', { n: createdCount })}
          </div>
        )}
        {unavailableReason && <div className="border-b border-critical/20 bg-critical/10 px-5 py-1.5 text-xs text-critical">{unavailableReason}</div>}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-ink-muted">
              <MessagesSquare size={28} className="opacity-50" />
              <p className="max-w-[320px] text-[13px]">
                {t('Describe one test at a time: Claude asks questions if needed, proposes a plan, then writes and saves it. Keep going to create as many as you like.')}
                {project.repo_path ? '' : ` ${t('(no repo_path set on the project: it will not be able to read the code)')}`}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((msg, idx) => (
                <Bubble key={idx} msg={msg} />
              ))}
              {running && <TypingIndicator />}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {error && <div className="error-banner mx-5 !mb-0">{error}</div>}

        {lines.length > 0 && (
          <div className="border-t border-gridline bg-surface px-5 py-1.5">
            <button type="button" className="ghost sm !px-1" onClick={() => setShowLog((v) => !v)}>
              {t('Claude activity')} ({lines.length})
            </button>
            {showLog && (
              <div ref={logRef} className="codeblock mt-1 max-h-32">
                {lines.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap break-words">
                    {l}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-gridline bg-surface px-4 py-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            disabled={busy || !ready}
            placeholder={
              messages.length === 0
                ? t('E.g. Log in with a valid user and check that the dashboard appears')
                : t('Answer, ask for changes, confirm the plan, or describe the next test…')
            }
            className="min-w-0 flex-1 resize-none !rounded-full"
          />
          {running ? (
            <button type="button" className="danger icon" onClick={() => window.insightest.agent.aiCancel()} title={t('Stop')}>
              <Square size={14} />
            </button>
          ) : (
            <button type="button" className="icon" onClick={() => void send(input)} disabled={busy || !ready || !input.trim()} title={t('Send')}>
              <Send size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
