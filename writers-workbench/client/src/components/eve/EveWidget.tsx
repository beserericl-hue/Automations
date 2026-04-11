import { ConversationProvider, useConversation } from '@elevenlabs/react';
import { useUser } from '../../contexts/UserContext';
import { ELEVENLABS_AGENT_ID } from '../../config/constants';

interface EveWidgetProps {
  onEnd: () => void;
}

export default function EveWidget({ onEnd }: EveWidgetProps) {
  const { profile } = useUser();

  return (
    <ConversationProvider>
      <EveSession
        agentId={ELEVENLABS_AGENT_ID}
        userId={profile?.user_id || ''}
        onEnd={onEnd}
      />
    </ConversationProvider>
  );
}

function EveSession({ agentId, userId, onEnd }: { agentId: string; userId: string; onEnd: () => void }) {
  const conversation = useConversation({
    onError: (error) => {
      console.error('Eve conversation error:', error);
    },
    onDisconnect: () => {
      onEnd();
    },
  });

  const handleStart = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      conversation.startSession({
        agentId,
        userId,
        connectionType: 'websocket',
        dynamicVariables: {
          system__caller_id: userId,
        },
      });
    } catch (err) {
      console.error('Failed to start Eve session:', err);
      alert('Microphone access is required to talk to Eve. Please allow microphone access and try again.');
      onEnd();
    }
  };

  const statusLabel =
    conversation.status === 'connected'
      ? conversation.isSpeaking ? 'Eve is speaking...' : 'Listening...'
      : conversation.status === 'connecting'
        ? 'Connecting...'
        : 'Ready';

  const statusColor =
    conversation.status === 'connected'
      ? conversation.isSpeaking ? 'bg-brand-500 animate-pulse' : 'bg-green-500 animate-pulse'
      : conversation.status === 'connecting'
        ? 'bg-yellow-500 animate-pulse'
        : 'bg-gray-400';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900 w-64">
      {conversation.status === 'disconnected' ? (
        <>
          <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">Talk to Eve, your writing assistant.</p>
          <button
            onClick={handleStart}
            className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Start Conversation
          </button>
          <p className="mt-2 text-xs text-gray-400">Requires microphone access.</p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-2">
            <div className={`h-3 w-3 rounded-full ${statusColor}`} />
            <span className="text-sm text-gray-700 dark:text-gray-300">{statusLabel}</span>
          </div>
          {conversation.message && (
            <p className="text-xs text-gray-500 mb-2 line-clamp-3">{conversation.message}</p>
          )}
          <button
            onClick={() => { conversation.endSession(); onEnd(); }}
            className="w-full rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
          >
            End Conversation
          </button>
        </>
      )}
    </div>
  );
}
