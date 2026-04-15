import { useState, useEffect, useCallback } from 'react';
import { useUser } from '../../contexts/UserContext';
import { supabase } from '../../config/supabase';

interface TutorialStep {
  title: string;
  description: string;
  icon: string;
  highlight?: string; // CSS selector to highlight
}

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    title: 'Welcome to The Writers Workbench',
    description:
      'This is your dashboard for managing AI-generated writing content. ' +
      'All content is created through chat or Eve voice — this web app is for viewing, editing, and organizing.',
    icon: 'M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25',
  },
  {
    title: 'Your Sidebar',
    description:
      'The sidebar shows your projects, content library, and reference materials. ' +
      'Click any project to open its full workspace with chapters, outline, story bible, and more.',
    icon: 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12',
    highlight: 'aside',
  },
  {
    title: 'Talk to Eve',
    description:
      'Eve is your AI writing assistant. Find her in the sidebar — click "Talk to Eve" to open the voice widget. ' +
      'Tell her what you want to write, brainstorm ideas, or review your content.',
    icon: 'M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z',
  },
  {
    title: 'Chat with the Author Agent',
    description:
      'Click the chat icon in the top bar to open the chat drawer. ' +
      'Use Quick Commands to get started: brainstorm a book, write a chapter, generate cover art, and more.',
    icon: 'M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z',
  },
  {
    title: 'Your First Project',
    description:
      'To create your first project, open the chat and say something like: ' +
      '"Brainstorm a book called The Last Signal, a post-apocalyptic survival story." ' +
      'Eve will create an outline, and your project will appear in the sidebar.',
    icon: 'M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75',
  },
];

const TUTORIAL_CONFIG_KEY = 'tutorial_completed';

export default function OnboardingTutorial() {
  const { profile } = useUser();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);

  // Check if tutorial has been completed
  useEffect(() => {
    if (!profile?.user_id) return;

    async function checkTutorialStatus() {
      // Check app_config_v2 first
      const { data } = await supabase
        .from('app_config_v2')
        .select('value')
        .eq('user_id', profile!.user_id)
        .eq('key', TUTORIAL_CONFIG_KEY)
        .maybeSingle();

      if (data?.value === 'true') {
        setVisible(false);
      } else {
        // Also check localStorage as fallback
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

  const completeTutorial = useCallback(async () => {
    if (!profile?.user_id) return;

    // Save to localStorage immediately
    localStorage.setItem(`tutorial_completed_${profile.user_id}`, 'true');

    // Save to app_config_v2
    await supabase.from('app_config_v2').upsert(
      { user_id: profile.user_id, key: TUTORIAL_CONFIG_KEY, value: 'true' },
      { onConflict: 'user_id,key' }
    );

    setVisible(false);
  }, [profile?.user_id]);

  const handleNext = () => {
    if (step < TUTORIAL_STEPS.length - 1) {
      setStep(step + 1);
    } else {
      completeTutorial();
    }
  };

  const handlePrev = () => {
    if (step > 0) setStep(step - 1);
  };

  const handleSkip = () => {
    completeTutorial();
  };

  if (loading || !visible || !profile) return null;

  const currentStep = TUTORIAL_STEPS[step];
  const isLast = step === TUTORIAL_STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" role="dialog" aria-label="Onboarding tutorial">
      <div className="relative mx-4 w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-8 shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        {/* Step indicator */}
        <div className="mb-6 flex items-center justify-between">
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
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 dark:bg-brand-900/30">
          <svg className="h-6 w-6 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d={currentStep.icon} />
          </svg>
        </div>

        {/* Content */}
        <h2 className="mb-2 text-xl font-bold text-gray-900 dark:text-white">{currentStep.title}</h2>
        <p className="mb-8 text-sm leading-relaxed text-gray-600 dark:text-gray-300">{currentStep.description}</p>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            onClick={handleSkip}
            className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            Skip tutorial
          </button>
          <div className="flex gap-3">
            {step > 0 && (
              <button
                onClick={handlePrev}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Back
              </button>
            )}
            <button
              onClick={handleNext}
              className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700"
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
