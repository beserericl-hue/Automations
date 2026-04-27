// First-login product tour. Each step optionally anchors a tooltip-style
// popover next to a real UI element and spotlights it with a cutout.
//
// Spotlight technique: a fixed div sized to the target's bounding rect, with
// `box-shadow: 0 0 0 9999px rgba(0,0,0,0.7)` — the inner area is transparent,
// the rest of the screen is dimmed. A blue glow is added via a second shadow.
//
// Modal placement: smart 4-way placement (top/bottom/left/right of target)
// based on which side has the most viewport room. Falls back to centered
// when no target exists (the welcome step).

import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { useUser } from '../../contexts/UserContext';
import { supabase } from '../../config/supabase';

interface TutorialStep {
  title: string;
  description: string;
  icon: string;
  /** CSS selector for the element this step is about. Omit to render centered. */
  target?: string;
  /** Optional explicit placement. Defaults to auto. */
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  /** Padding around the spotlight cutout, in px (default 8). */
  spotlightPadding?: number;
}

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    title: 'Welcome to The Writers Workbench',
    description:
      'This is your dashboard for managing AI-generated writing content. ' +
      'All content is created through chat or Eve voice — this web app is for viewing, editing, and organizing.',
    icon: 'M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25',
    placement: 'center',
  },
  {
    title: 'Your Sidebar',
    description:
      'The sidebar shows your projects, content library, and reference materials. ' +
      'Click any project to open its full workspace with chapters, outline, story bible, and more.',
    icon: 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12',
    target: '[data-tour="sidebar"]',
    placement: 'right',
    spotlightPadding: 0,
  },
  {
    title: 'Talk to Eve',
    description:
      'Eve is your AI writing assistant. Click here in the sidebar to open her voice widget. ' +
      'Tell her what you want to write, brainstorm ideas, or review your content.',
    icon: 'M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z',
    target: '[data-tour="eve"]',
    placement: 'right',
  },
  {
    title: 'Chat with the Author Agent',
    description:
      'Click the chat icon in the top bar to open the chat drawer. ' +
      'Use Quick Commands to brainstorm a book, write a chapter, generate cover art, and more.',
    icon: 'M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z',
    target: '[data-tour="chat-button"]',
    placement: 'bottom',
  },
  {
    title: 'Your First Project',
    description:
      'Open the chat (top-bar icon) and say something like: ' +
      '"Brainstorm a book called The Last Signal, a post-apocalyptic survival story." ' +
      'Eve will create an outline, and your project will appear in the sidebar.',
    icon: 'M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75',
    target: '[data-tour="chat-button"]',
    placement: 'bottom',
  },
];

const TUTORIAL_CONFIG_KEY = 'tutorial_completed';

interface Rect { top: number; left: number; width: number; height: number }

function computeRect(el: Element, padding: number): Rect {
  const r = el.getBoundingClientRect();
  return {
    top: Math.max(0, r.top - padding),
    left: Math.max(0, r.left - padding),
    width: r.width + padding * 2,
    height: r.height + padding * 2,
  };
}

interface PopoverPosition { top: number; left: number; placement: 'top' | 'bottom' | 'left' | 'right' | 'center' }

const POPOVER_WIDTH = 480;
const POPOVER_HEIGHT_EST = 280; // estimate for placement scoring
const GAP = 16;

function pickPlacement(
  rect: Rect | null,
  preferred: TutorialStep['placement'],
  vw: number,
  vh: number,
): PopoverPosition {
  if (!rect || preferred === 'center') {
    return {
      top: Math.max(16, (vh - POPOVER_HEIGHT_EST) / 2),
      left: Math.max(16, (vw - POPOVER_WIDTH) / 2),
      placement: 'center',
    };
  }

  // Score each side by available room. Prefer the explicit placement if it fits.
  const room = {
    top: rect.top - GAP,
    bottom: vh - (rect.top + rect.height) - GAP,
    left: rect.left - GAP,
    right: vw - (rect.left + rect.width) - GAP,
  };
  const fits = {
    top: room.top >= POPOVER_HEIGHT_EST,
    bottom: room.bottom >= POPOVER_HEIGHT_EST,
    left: room.left >= POPOVER_WIDTH,
    right: room.right >= POPOVER_WIDTH,
  };

  type Side = 'top' | 'bottom' | 'left' | 'right';
  let chosen: Side = 'bottom';
  if (preferred && fits[preferred]) {
    chosen = preferred;
  } else {
    // Pick the side with the most room.
    const sides: Side[] = ['right', 'bottom', 'left', 'top'];
    sides.sort((a, b) => room[b] - room[a]);
    chosen = sides[0];
  }

  let top = 0;
  let left = 0;
  if (chosen === 'top') {
    top = rect.top - POPOVER_HEIGHT_EST - GAP;
    left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
  } else if (chosen === 'bottom') {
    top = rect.top + rect.height + GAP;
    left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
  } else if (chosen === 'left') {
    top = rect.top + rect.height / 2 - POPOVER_HEIGHT_EST / 2;
    left = rect.left - POPOVER_WIDTH - GAP;
  } else {
    top = rect.top + rect.height / 2 - POPOVER_HEIGHT_EST / 2;
    left = rect.left + rect.width + GAP;
  }

  // Clamp to viewport with 16px margin
  top = Math.max(16, Math.min(top, vh - POPOVER_HEIGHT_EST - 16));
  left = Math.max(16, Math.min(left, vw - POPOVER_WIDTH - 16));
  return { top, left, placement: chosen };
}

export default function OnboardingTutorial() {
  const { profile } = useUser();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rect, setRect] = useState<Rect | null>(null);
  const [popover, setPopover] = useState<PopoverPosition>({ top: 0, left: 0, placement: 'center' });
  const popoverRef = useRef<HTMLDivElement>(null);

  // Check if tutorial has been completed
  useEffect(() => {
    if (!profile?.user_id) return;

    async function checkTutorialStatus() {
      const { data } = await supabase
        .from('app_config_v2')
        .select('value')
        .eq('user_id', profile!.user_id)
        .eq('key', TUTORIAL_CONFIG_KEY)
        .maybeSingle();

      if (data?.value === 'true') {
        setVisible(false);
      } else {
        const local = localStorage.getItem(`tutorial_completed_${profile!.user_id}`);
        if (local === 'true') {
          setVisible(false);
        } else {
          setVisible(true);
        }
      }
      setLoading(false);
    }

    checkTutorialStatus();
  }, [profile?.user_id]);

  const currentStep = TUTORIAL_STEPS[step];

  // Re-measure target on step change, scroll, resize, and content reflow.
  useLayoutEffect(() => {
    if (!visible) return;
    if (!currentStep.target) {
      setRect(null);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setPopover(pickPlacement(null, 'center', vw, vh));
      return;
    }

    const el = document.querySelector(currentStep.target);
    if (!el) {
      // Element not on the page right now (e.g. sidebar collapsed). Fall back to centered.
      setRect(null);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setPopover(pickPlacement(null, 'center', vw, vh));
      return;
    }

    // Bring the target into view if it's offscreen.
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

    const padding = currentStep.spotlightPadding ?? 8;
    const update = () => {
      const r = computeRect(el, padding);
      setRect(r);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setPopover(pickPlacement(r, currentStep.placement, vw, vh));
    };
    update();

    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(document.body);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    // Re-measure once layout settles after the smooth-scroll animation.
    const settled = window.setTimeout(update, 350);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.clearTimeout(settled);
    };
  }, [visible, step, currentStep.target, currentStep.placement, currentStep.spotlightPadding]);

  const completeTutorial = useCallback(async () => {
    if (!profile?.user_id) return;
    localStorage.setItem(`tutorial_completed_${profile.user_id}`, 'true');
    await supabase.from('app_config_v2').upsert(
      { user_id: profile.user_id, key: TUTORIAL_CONFIG_KEY, value: 'true' },
      { onConflict: 'user_id,key' },
    );
    setVisible(false);
  }, [profile?.user_id]);

  const handleNext = () => {
    if (step < TUTORIAL_STEPS.length - 1) setStep(step + 1);
    else completeTutorial();
  };
  const handlePrev = () => {
    if (step > 0) setStep(step - 1);
  };
  const handleSkip = () => completeTutorial();

  if (loading || !visible || !profile) return null;

  const isLast = step === TUTORIAL_STEPS.length - 1;
  const hasSpotlight = rect !== null;

  return (
    <div className="pointer-events-none" role="dialog" aria-label="Onboarding tutorial">
      {/* Backdrop dim — implemented via the spotlight shadow when there's a
          target, or a plain dark overlay when there isn't. */}
      {!hasSpotlight && (
        <div
          className="pointer-events-auto fixed inset-0 z-[100] bg-black/60"
          onClick={handleSkip}
        />
      )}

      {/* Spotlight cutout */}
      {hasSpotlight && rect && (
        <div
          className="pointer-events-none fixed z-[100] rounded-lg transition-all duration-300 ease-out"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            boxShadow:
              '0 0 0 9999px rgba(0,0,0,0.7), 0 0 0 3px rgba(59,130,246,0.85), 0 0 24px 8px rgba(59,130,246,0.45)',
          }}
        />
      )}

      {/* Popover */}
      <div
        ref={popoverRef}
        className="pointer-events-auto fixed z-[101] rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl transition-all duration-300 ease-out dark:border-gray-700 dark:bg-gray-900"
        style={{
          top: popover.top,
          left: popover.left,
          width: POPOVER_WIDTH,
          maxWidth: 'calc(100vw - 32px)',
        }}
      >
        {/* Step indicator */}
        <div className="mb-5 flex items-center justify-between">
          <div className="flex gap-1.5">
            {TUTORIAL_STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 w-8 rounded-full transition-colors ${
                  i <= step ? 'bg-brand-600' : 'bg-gray-200 dark:bg-gray-700'
                }`}
              />
            ))}
          </div>
          <span className="text-xs text-gray-400">
            {step + 1} of {TUTORIAL_STEPS.length}
          </span>
        </div>

        {/* Icon */}
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 dark:bg-brand-900/30">
          <svg className="h-5 w-5 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d={currentStep.icon} />
          </svg>
        </div>

        {/* Content */}
        <h2 className="mb-2 text-lg font-bold text-gray-900 dark:text-white">{currentStep.title}</h2>
        <p className="mb-6 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          {currentStep.description}
        </p>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            onClick={handleSkip}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            Skip tutorial
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={handlePrev}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Back
              </button>
            )}
            <button
              onClick={handleNext}
              className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              {isLast ? 'Get started' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Resets the tutorial for the current user.
 * Called from Settings page "Replay Tutorial" button.
 */
export async function resetTutorial(userId: string) {
  localStorage.removeItem(`tutorial_completed_${userId}`);
  await supabase
    .from('app_config_v2')
    .delete()
    .eq('user_id', userId)
    .eq('key', TUTORIAL_CONFIG_KEY);
}
