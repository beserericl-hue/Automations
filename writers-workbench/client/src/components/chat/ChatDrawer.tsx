import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { useUser } from '../../contexts/UserContext';
import { supabase } from '../../config/supabase';
import { N8N_WEBHOOK_URL } from '../../config/constants';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string; // ISO string for localStorage serialization
  isAsync?: boolean;
}

interface ChatDrawerProps {
  open: boolean;
  onClose: () => void;
}

const CHAT_STORAGE_KEY = 'writers-workbench-chat-history';
const MAX_MESSAGES = 100;

const QUICK_COMMANDS = [
  { label: 'List my projects', command: 'List my projects' },
  { label: 'Brainstorm a book...', command: 'Brainstorm a book called ' },
  { label: 'Write a chapter...', command: 'Write chapter 1 of ' },
  { label: 'Research a topic...', command: 'Research ' },
  { label: 'Generate cover art...', command: 'Generate cover art for ' },
  { label: 'Repurpose for social...', command: 'Repurpose to social media: ' },
  { label: 'List my outlines', command: 'List all outlines' },
  { label: 'Approve content...', command: 'Approve ' },
];

// Async operations don't return immediate data
const ASYNC_PATTERNS = [
  /^(write|brainstorm|generate|repurpose|create)/i,
];

function isAsyncCommand(text: string): boolean {
  return ASYNC_PATTERNS.some(p => p.test(text.trim()));
}

function loadMessages(): Message[] {
  try {
    const stored = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as Message[];
    return parsed.slice(-MAX_MESSAGES);
  } catch {
    return [];
  }
}

function saveMessages(messages: Message[]) {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
  } catch {
    // localStorage full — clear old messages
    localStorage.removeItem(CHAT_STORAGE_KEY);
  }
}

export default function ChatDrawer({ open, onClose }: ChatDrawerProps) {
  const { profile } = useUser();
  const location = useLocation();
  const params = useParams<{ id: string }>();
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(480);
  const [isResizing, setIsResizing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Detect current project context for context-aware suggestions
  const isOnProject = location.pathname.startsWith('/projects/') && params.id;
  const { data: currentProject } = useQuery({
    queryKey: ['project-context', params.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('writing_projects_v2')
        .select('title, chapter_count')
        .eq('id', params.id!)
        .single();
      return data as { title: string; chapter_count: number } | null;
    },
    enabled: !!isOnProject,
  });

  // Persist messages to localStorage
  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Resize drag handler
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = drawerWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(360, Math.min(800, startWidth + (startX - e.clientX)));
      setDrawerWidth(newWidth);
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [drawerWidth]);

  const addMessage = (msg: Message) => {
    setMessages(prev => [...prev.slice(-(MAX_MESSAGES - 1)), msg]);
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: Message = { role: 'user', content: text, timestamp: new Date().toISOString() };
    addMessage(userMsg);
    setInput('');
    setSending(true);

    const async_ = isAsyncCommand(text);

    try {
      let url = N8N_WEBHOOK_URL;
      let response: Response;

      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_message_request: text,
            user_id: profile?.user_id || '',
          }),
        });
      } catch {
        // CORS likely blocked — use proxy
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        response = await fetch('/api/chat/proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            user_message_request: text,
            user_id: profile?.user_id || '',
          }),
        });
      }

      const data = await response.json();
      const assistantContent = data.output || data.text || data.message || JSON.stringify(data);

      if (async_) {
        addMessage({
          role: 'assistant',
          content: 'Command sent. Results will appear in your Content Library when ready.',
          timestamp: new Date().toISOString(),
          isAsync: true,
        });
      } else {
        addMessage({
          role: 'assistant',
          content: assistantContent,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      addMessage({
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'Failed to send message'}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleQuickCommand = (command: string) => {
    setInput(command);
    setShowCommands(false);
    inputRef.current?.focus();
  };

  const clearHistory = () => {
    setMessages([]);
    localStorage.removeItem(CHAT_STORAGE_KEY);
  };

  // Context-aware commands based on current page
  const contextCommands = currentProject ? [
    { label: `Write next chapter of "${currentProject.title}"`, command: `Write chapter ${(currentProject.chapter_count || 0) + 1} of ${currentProject.title}` },
    { label: `Generate cover art for "${currentProject.title}"`, command: `Generate cover art for ${currentProject.title}` },
    { label: `Repurpose "${currentProject.title}" for social`, command: `Repurpose ${currentProject.title} to social media` },
  ] : [];

  return (
    <>
      {/* Backdrop */}
      {open && <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />}

      {/* Drawer */}
      <div
        className={`fixed right-0 top-0 z-50 flex h-full transform flex-col border-l border-gray-200 bg-white shadow-xl transition-transform dark:border-gray-800 dark:bg-gray-950 ${open ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ width: `${drawerWidth}px`, maxWidth: '100vw' }}
      >
        {/* Resize handle */}
        <div
          className={`absolute left-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-brand-500/30 ${isResizing ? 'bg-brand-500/30' : ''}`}
          onMouseDown={handleResizeStart}
        />

        {/* Header */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Chat with Author Agent</h2>
          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                onClick={clearHistory}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                title="Clear chat history"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
            <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center mt-8">
              <svg className="mx-auto h-10 w-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
              <p className="mt-3 text-sm font-medium text-gray-700 dark:text-gray-300">Start by telling the AI what you'd like to create</p>
              <p className="mt-1 text-xs text-gray-400">Examples: "Brainstorm a sci-fi novel", "List my projects", "Write chapter 1 of My Book"</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-brand-600 text-white'
                  : msg.isAsync
                    ? 'bg-yellow-50 text-yellow-800 border border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-300 dark:border-yellow-800'
                    : 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
              }`}>
                {msg.role === 'assistant' ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  msg.content
                )}
                <div className={`mt-1 text-[10px] ${
                  msg.role === 'user' ? 'text-white/60' : 'text-gray-400'
                }`}>
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-500 dark:bg-gray-800">
                <div className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '0ms' }} />
                  <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '150ms' }} />
                  <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick Commands panel */}
        {showCommands && (
          <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
            <div className="mb-2 text-xs font-medium text-gray-500">Quick Commands</div>

            {/* Context-aware commands */}
            {contextCommands.length > 0 && (
              <div className="mb-2">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-brand-600 dark:text-brand-400">Current Project</div>
                {contextCommands.map((cmd, i) => (
                  <button
                    key={`ctx-${i}`}
                    onClick={() => handleQuickCommand(cmd.command)}
                    className="mb-1 block w-full rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-brand-50 dark:text-gray-300 dark:hover:bg-brand-900/20"
                  >
                    {cmd.label}
                  </button>
                ))}
                <hr className="my-2 border-gray-200 dark:border-gray-700" />
              </div>
            )}

            {/* Standard quick commands */}
            <div className="grid grid-cols-2 gap-1">
              {QUICK_COMMANDS.map((cmd, i) => (
                <button
                  key={i}
                  onClick={() => handleQuickCommand(cmd.command)}
                  className="rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  {cmd.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input */}
        <div className="shrink-0 border-t border-gray-200 p-3 dark:border-gray-800">
          <div className="flex items-end gap-2">
            <button
              onClick={() => setShowCommands(!showCommands)}
              className={`shrink-0 rounded-lg p-2 ${showCommands ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
              title="Quick Commands"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
              </svg>
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              disabled={sending}
              rows={1}
              className="max-h-24 min-h-[36px] flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              style={{ height: 'auto' }}
              onInput={e => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = `${Math.min(target.scrollHeight, 96)}px`;
              }}
            />
            <button
              onClick={sendMessage}
              disabled={sending || !input.trim()}
              className="shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
