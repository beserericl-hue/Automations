import { useEffect, useRef } from 'react';
import { ELEVENLABS_AGENT_ID } from '../../config/constants';

interface EveWidgetProps {
  onEnd: () => void;
}

export default function EveWidget({ onEnd }: EveWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scriptLoadedRef = useRef(false);

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
      containerRef.current.appendChild(widget);
    }

    return () => {
      // Clean up widget on unmount
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, []);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900 w-72">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Talk to Eve</h3>
        <button
          onClick={onEnd}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          title="Close"
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
