import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Check,
  Copy,
  MessageSquarePlus,
  RotateCcw,
  Send,
  User,
  X,
} from 'lucide-react';
import { TranslationStrings } from '../i18n/translations';
import {
  ActiveWorkspaceView,
  ApiMode,
  PlatformId,
  SupportedLanguage,
  ThemeMode,
  UserRole,
} from '../types/reelsync';
import { ChatbotIcon } from './ChatbotIcon';

export interface HelpWorkspaceContext {
  activeRole: UserRole;
  theme: ThemeMode;
  platforms: Array<{
    id: PlatformId;
    name: string;
    connected: boolean;
    apiMode: ApiMode;
  }>;
  queueSummary: {
    totalReels: number;
    publishedJobs: number;
    scheduledOrQueued: number;
    needsAttention: number;
  };
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
}

interface HelpChatbotProps {
  isOpen: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  language: SupportedLanguage;
  currentView: ActiveWorkspaceView;
  isOwnerAdmin: boolean;
  workspaceContext?: HelpWorkspaceContext;
  t: TranslationStrings;
}

export const HelpChatbot: React.FC<HelpChatbotProps> = ({
  isOpen,
  onToggleOpen,
  onClose,
  language,
  currentView,
  isOwnerAdmin,
  workspaceContext,
  t,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: t.botGreeting,
    },
  ]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const listEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  const isRtl = language === 'ur' || language === 'ar';

  useEffect(() => {
    setMessages((prev) => {
      if (prev.length === 1 && prev[0].id === 'welcome') {
        return [{ id: 'welcome', role: 'assistant', text: t.botGreeting }];
      }
      return prev;
    });
  }, [t.botGreeting]);

  useEffect(() => {
    if (isOpen) {
      listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      const timer = setTimeout(() => inputRef.current?.focus(), 120);
      return () => clearTimeout(timer);
    }
  }, [messages, isOpen, isSending]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleCopyMessage = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1500);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  const sendQuestion = async (rawQuestion: string, isRetry = false) => {
    const trimmed = rawQuestion.trim();
    if (!trimmed || isSending) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setErrorMsg(null);
    setLastFailedPrompt(null);

    const baseMessages = messagesRef.current.filter((m) => !m.streaming || m.text.trim().length > 0);
    const nextMessages: ChatMessage[] = isRetry
      ? baseMessages
      : [
          ...baseMessages,
          {
            id: `u-${Date.now()}`,
            role: 'user',
            text: trimmed,
          },
        ];

    if (!isRetry) {
      setMessages(nextMessages);
      setInput('');
    }
    setIsSending(true);

    const assistantMsgId = `a-${Date.now()}`;
    let hasInsertedAssistant = false;
    let accumulated = '';

    try {
      const apiMessages = nextMessages
        .filter((m) => m.id !== 'welcome')
        .map((m) => ({ role: m.role, text: m.text }));

      const doFetch = async () =>
        fetch('/api/help-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            messages: apiMessages,
            language,
            currentView,
            isAdmin: isOwnerAdmin,
            workspaceContext,
            stream: false,
          }),
        });

      let res = await doFetch();
      if ((res.status === 503 || res.status === 429) && !controller.signal.aborted) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, 1100);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        res = await doFetch();
      }

      const contentType = res.headers.get('content-type') || '';

      if (!res.ok) {
        let errText = `Request failed (${res.status})`;
        if (contentType.includes('application/json')) {
          const data = (await res.json()) as { error?: string };
          if (data.error) errText = data.error;
        }
        throw new Error(errText);
      }

      if (contentType.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (controller.signal.aborted) break;

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const line = frame
              .split('\n')
              .find((l) => l.startsWith('data: '));
            if (!line) continue;

            const payloadStr = line.slice(6).trim();
            if (!payloadStr) continue;

            let parsed: { delta?: string; error?: string; done?: boolean };
            try {
              parsed = JSON.parse(payloadStr) as {
                delta?: string;
                error?: string;
                done?: boolean;
              };
            } catch {
              continue;
            }

            if (parsed.error) {
              throw new Error(parsed.error);
            }

            if (parsed.delta) {
              accumulated += parsed.delta;
              if (!hasInsertedAssistant) {
                hasInsertedAssistant = true;
                setMessages((prev) => [
                  ...prev,
                  {
                    id: assistantMsgId,
                    role: 'assistant',
                    text: accumulated,
                    streaming: true,
                  },
                ]);
              } else {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId ? { ...m, text: accumulated } : m
                  )
                );
              }
            }
          }
        }

        if (!controller.signal.aborted) {
          if (!accumulated.trim()) {
            throw new Error('The assistant returned an empty response. Please tap Retry.');
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, text: accumulated.trim(), streaming: false }
                : m
            )
          );
        }
      } else {
        const data = (await res.json()) as { reply?: string; error?: string };
        if (!data.reply) {
          throw new Error(data.error || 'Unable to get a response.');
        }
        setMessages((prev) => [
          ...prev,
          {
            id: assistantMsgId,
            role: 'assistant',
            text: data.reply as string,
          },
        ]);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      // Clean up empty or incomplete streaming bubble if failed
      if (hasInsertedAssistant && !accumulated.trim()) {
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
      } else if (hasInsertedAssistant) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, streaming: false } : m
          )
        );
      }
      const message =
        err instanceof Error ? err.message : 'Unable to reach Help Assistant.';
      setErrorMsg(message);
      setLastFailedPrompt(trimmed);
    } finally {
      if (abortRef.current === controller) {
        setIsSending(false);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendQuestion(input);
  };

  const handleResetChat = () => {
    abortRef.current?.abort();
    setIsSending(false);
    setMessages([{ id: 'welcome', role: 'assistant', text: t.botGreeting }]);
    setErrorMsg(null);
    setLastFailedPrompt(null);
  };

  const showThinkingDots =
    isSending &&
    messages[messages.length - 1]?.role !== 'assistant';

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="flex flex-col items-end gap-2.5">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-label={t.botTitle}
            className="w-[min(calc(100vw-2rem),385px)] max-h-[min(74dvh,520px)] flex flex-col bg-white dark:bg-[#07132A] border border-blue-200 dark:border-blue-800/80 rounded-2xl shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="px-4 py-3 bg-[#F2F7FF] dark:bg-[#0A1A38] border-b border-blue-200 dark:border-blue-800/80 flex items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600/18 to-sky-500/15 border border-blue-500/35 flex items-center justify-center text-blue-700 dark:text-sky-300 shrink-0">
                  <ChatbotIcon className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="font-display text-xs font-semibold text-blue-950 dark:text-blue-50 truncate">
                    {t.botTitle}
                  </p>
                  <p className="text-[11px] text-blue-800/75 dark:text-blue-300/75 truncate">
                    {t.botSubtitle}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={handleResetChat}
                  title={t.botClear}
                  aria-label={t.botClear}
                  className="p-1.5 rounded-md text-blue-700 hover:text-blue-950 hover:bg-blue-100 dark:text-blue-300 dark:hover:text-blue-50 dark:hover:bg-blue-900/60 transition-colors"
                >
                  <MessageSquarePlus className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t.botCloseAria}
                  className="p-1.5 rounded-md text-blue-700 hover:text-blue-950 hover:bg-blue-100 dark:text-blue-300 dark:hover:text-blue-50 dark:hover:bg-blue-900/60 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-3 min-h-[250px] max-h-[325px] bg-[#F8FBFF] dark:bg-[#051024]">
              {messages.map((msg) => {
                const isUser = msg.role === 'user';
                const canCopy = !isUser && !msg.streaming && msg.id !== 'welcome';
                return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.16 }}
                    className={`flex items-start gap-2 ${
                      isUser ? 'flex-row-reverse' : 'flex-row'
                    }`}
                  >
                    <div
                      className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                        isUser
                          ? 'bg-blue-600 text-white dark:bg-blue-500 dark:text-slate-950'
                          : 'bg-blue-100 text-blue-800 dark:bg-blue-900/75 dark:text-sky-300'
                      }`}
                    >
                      {isUser ? (
                        <User className="w-3.5 h-3.5" />
                      ) : (
                        <ChatbotIcon className="w-3.5 h-3.5" />
                      )}
                    </div>
                    <div className="max-w-[82%] group space-y-1">
                      <div
                        className={`rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                          isUser
                            ? 'bg-blue-600 text-white dark:bg-blue-500 dark:text-slate-950 font-medium'
                            : 'bg-white dark:bg-[#0A1A38] border border-blue-200 dark:border-blue-900/80 text-blue-950 dark:text-blue-100'
                        }`}
                      >
                        {msg.text}
                      </div>
                      {canCopy && (
                        <button
                          type="button"
                          onClick={() => void handleCopyMessage(msg.id, msg.text)}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-blue-700/70 hover:text-blue-950 dark:text-blue-300/65 dark:hover:text-blue-100 transition-colors"
                          aria-label="Copy reply"
                        >
                          {copiedId === msg.id ? (
                            <>
                              <Check className="w-3 h-3 text-sky-600 dark:text-sky-400" />
                              <span>Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </motion.div>
                );
              })}

              {showThinkingDots && (
                <div className="flex items-center gap-2 text-xs text-blue-700 dark:text-blue-300">
                  <div className="w-6 h-6 rounded-lg bg-blue-100 dark:bg-blue-900/75 text-blue-800 dark:text-sky-300 flex items-center justify-center shrink-0">
                    <ChatbotIcon className="w-3.5 h-3.5" />
                  </div>
                  <div className="px-3 py-2 rounded-xl bg-white dark:bg-[#0A1A38] border border-blue-200 dark:border-blue-900/80 inline-flex items-center gap-2">
                    <span>{t.botThinking}</span>
                    <span className="inline-flex gap-1">
                      <motion.span
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1, repeat: Infinity, delay: 0 }}
                        className="w-1 h-1 rounded-full bg-blue-600 dark:bg-sky-400"
                      />
                      <motion.span
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1, repeat: Infinity, delay: 0.2 }}
                        className="w-1 h-1 rounded-full bg-blue-600 dark:bg-sky-400"
                      />
                      <motion.span
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1, repeat: Infinity, delay: 0.4 }}
                        className="w-1 h-1 rounded-full bg-blue-600 dark:bg-sky-400"
                      />
                    </span>
                  </div>
                </div>
              )}

              {errorMsg && (
                <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-2.5 text-xs text-red-700 dark:text-red-300 space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <p className="break-words">{errorMsg}</p>
                  </div>
                  {lastFailedPrompt && (
                    <button
                      type="button"
                      onClick={() => void sendQuestion(lastFailedPrompt, true)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>{t.botRetry}</span>
                    </button>
                  )}
                </div>
              )}

              {/* Quick Suggestions on first turn */}
              {messages.length <= 1 && !isSending && (
                <div className="pt-1 flex flex-wrap gap-1.5">
                  {t.botQuickPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => void sendQuestion(prompt)}
                      className="text-left text-[11px] px-2.5 py-1.5 rounded-lg bg-[#EAF2FF] hover:bg-blue-100 dark:bg-[#0A1A38] dark:hover:bg-blue-900/60 border border-blue-200 dark:border-blue-800/80 text-blue-900 dark:text-blue-200 transition-colors"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}

              <div ref={listEndRef} />
            </div>

            {/* Composer */}
            <form
              onSubmit={handleSubmit}
              className="p-2.5 bg-white dark:bg-[#07132A] border-t border-blue-200 dark:border-blue-800/80 flex items-center gap-2 shrink-0"
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t.botPlaceholder}
                maxLength={1000}
                disabled={isSending}
                className="flex-1 bg-[#F2F7FF] dark:bg-[#051024] border border-blue-200 dark:border-blue-800/80 focus:border-blue-500 rounded-lg px-3 py-2 text-xs text-blue-950 dark:text-blue-50 placeholder:text-blue-600/50 focus:outline-none disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={isSending || !input.trim()}
                aria-label={t.botSend}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-gradient-to-r from-blue-600 to-sky-600 hover:from-blue-700 hover:to-sky-700 text-white dark:from-blue-500 dark:to-sky-400 dark:hover:from-blue-400 dark:hover:to-sky-300 dark:text-slate-950 transition-all disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{t.botSend}</span>
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Chatbot Trigger Button with Custom Assistant Icon */}
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.96 }}
        type="button"
        onClick={onToggleOpen}
        aria-label={isOpen ? t.botCloseAria : t.botOpenAria}
        aria-expanded={isOpen}
        title={t.botTitle}
        className="w-11 h-11 rounded-full bg-gradient-to-br from-blue-600 to-sky-500 hover:from-blue-700 hover:to-sky-600 dark:from-blue-500 dark:to-sky-400 dark:hover:from-blue-400 dark:hover:to-sky-300 text-white dark:text-slate-950 shadow-lg border border-blue-400/50 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[#EAF2FF] dark:focus-visible:ring-offset-[#040B1A]"
      >
        {isOpen ? <X className="w-4 h-4" /> : <ChatbotIcon className="w-5 h-5" />}
      </motion.button>
    </div>
  );
};
