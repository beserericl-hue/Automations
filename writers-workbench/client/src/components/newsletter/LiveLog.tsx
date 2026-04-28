/**
 * LiveLog — terminal-style scrolling feed of newsletter.stage SSE events.
 *
 * Auto-scrolls to bottom when the user is already near the bottom (within
 * ~24px). When the user has scrolled up, auto-scroll pauses and a
 * scroll-lock indicator appears at the bottom edge — clicking it scrolls
 * back down and resumes auto-scroll. This is the standard pattern for
 * tail-style log views (and it's what the design doc §4.2 requested).
 */
import { useEffect, useRef, useState } from 'react';
import type { NewsletterStageEventData } from '../../lib/newsletter/schema';

interface LiveLogProps {
  events: NewsletterStageEventData[];
  /** When set, surfaces a permanent error banner at the top. */
  errorEvent?: NewsletterStageEventData | null;
}

const STICK_THRESHOLD_PX = 24;

export default function LiveLog({ events, errorEvent }: LiveLogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);

  function scrollToBottom() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setStuckToBottom(distanceFromBottom <= STICK_THRESHOLD_PX);
  }

  // Auto-scroll on new events when user is near the bottom.
  useEffect(() => {
    if (stuckToBottom) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  function handleResume() {
    setStuckToBottom(true);
    scrollToBottom();
  }

  return (
    <div className="relative rounded-lg border border-gray-200 bg-gray-900 text-gray-100 dark:border-gray-700 dark:bg-black">
      {errorEvent && (
        <div role="alert" className="border-b border-red-900/60 bg-red-950/60 px-3 py-1.5 text-xs text-red-200">
          <strong>{errorEvent.stage}:</strong> {errorEvent.detail || 'workflow error'}
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Newsletter execution events"
        className="block max-h-[60vh] min-h-[300px] overflow-y-auto p-3 font-mono text-xs"
      >
        {events.length === 0 ? (
          <p className="text-gray-500">Waiting for events…</p>
        ) : (
          <ul className="space-y-0.5">
            {events.map((e, i) => (
              <li key={`${e.executionId}-${e.stage}-${e.ts}-${i}`} className="flex gap-2 leading-5">
                <span className="shrink-0 text-gray-500">{formatTime(e.ts)}</span>
                <span className="shrink-0 text-brand-300">{e.stage}</span>
                <span className="text-gray-300 break-words">{e.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!stuckToBottom && (
        <button
          type="button"
          onClick={handleResume}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white shadow-lg hover:bg-brand-700"
        >
          ↓ New events
        </button>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return iso;
  }
}
