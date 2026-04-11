import { useConversation } from '@elevenlabs/react';
import { useEffect } from 'react';
import { useUser } from '../../contexts/UserContext';
import { ELEVENLABS_AGENT_ID } from '../../config/constants';

interface EveWidgetProps {
  onEnd: () => void;
}

export default function EveWidget({ onEnd }: EveWidgetProps) {
  const { profile } = useUser();

  const conversation = useConversation({
    onError: (error) => {
      console.error('Eve conversation error:', error);
    },
    onDisconnect: () => {
      onEnd();
    },
  });

  useEffect(() => {
    // Start the conversation when widget mounts
    const start = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        await conversation.startSession({
          agentId: ELEVENLABS_AGENT_ID,
          dynamicVariables: {
            system__caller_id: profile?.user_id || '',
          },
        });
      } catch (err) {
        console.error('Failed to start Eve session:', err);
        onEnd();
      }
    };
    start();

    return () => {
      conversation.endSession();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const statusText = conversation.status === 'connected'
    ? conversation.isSpeaking ? 'Eve is speaking...' : 'Listening...'
    : 'Connecting...';

  return (
    <div className="fixed bottom-24 right-6 z-30 rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900 w-64">
      {/* Status indicator */}
      <div className="flex items-center gap-3">
        <div className={`h-3 w-3 rounded-full ${
          conversation.status === 'connected'
            ? conversation.isSpeaking ? 'bg-brand-500 animate-pulse' : 'bg-green-500 animate-pulse'
            : 'bg-yellow-500'
        }`} />
        <span className="text-sm text-gray-700 dark:text-gray-300">{statusText}</span>
      </div>
      <p className="mt-2 text-xs text-gray-400">Click the orb to end the conversation.</p>
    </div>
  );
}
