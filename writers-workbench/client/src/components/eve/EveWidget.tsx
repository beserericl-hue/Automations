import { useEffect, useRef } from 'react';
import { ELEVENLABS_AGENT_ID } from '../../config/constants';
import { useUser } from '../../contexts/UserContext';
import { supabase } from '../../config/supabase';

interface EveWidgetProps {
  onEnd: () => void;
}

async function getAuthToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || null;
}

async function registerSession() {
  const token = await getAuthToken();
  if (!token) return;
  try {
    await fetch('/api/session/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
  } catch {
    // Fail silently — session registration is best-effort
  }
}

async function unregisterSession() {
  const token = await getAuthToken();
  if (!token) return;
  try {
    await fetch('/api/session/unregister', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Fail silently
  }
}

export default function EveWidget({ onEnd }: EveWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scriptLoadedRef = useRef(false);
  const { profile } = useUser();

  useEffect(() => {
    // Load the ElevenLabs convai widget script once
    if (!scriptLoadedRef.current) {
      const existing = document.querySelector('script[src*="elevenlabs/convai-widget"]');
      if (!existing) {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/@elevenlabs/convai-widget-embed';
        script.async = true;
        script.type = 'text/javascript';
        document.body.appendChild(script);
      }
      scriptLoadedRef.current = true;
    }

    // Create the custom element
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      const widget = document.createElement('elevenlabs-convai');
      widget.setAttribute('agent-id', ELEVENLABS_AGENT_ID);

      // Pass user_id so n8n receives the phone number for DB lookups.
      // For web widget calls, ElevenLabs doesn't set system__caller_id
      // (that only works for phone calls). We inject it via:
      // 1. dynamic-variables — injected into agent prompt context
      // 2. client-tools override — the agent's tools see this in context
      if (profile?.user_id) {
        widget.setAttribute('dynamic-variables', JSON.stringify({
          user_id: profile.user_id,
          user_name: profile.display_name || '',
          source: 'web_widget',
        }));
      }

      containerRef.current.appendChild(widget);
    }

    // Register web session so n8n routes callbacks to web instead of phone
    registerSession();

    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
      // Unregister session on widget unmount
      unregisterSession();
    };
  }, [profile?.user_id]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900 w-72" role="dialog" aria-label="Eve voice assistant">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Talk to Eve</h3>
        <button
          onClick={onEnd}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          title="Close"
          aria-label="Close Eve voice widget"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div ref={containerRef} />
      <p className="mt-2 text-xs text-gray-400">Click the microphone to start speaking with Eve.</p>
    </div>
  );
}
