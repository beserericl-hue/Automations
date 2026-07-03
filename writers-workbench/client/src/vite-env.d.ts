/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_N8N_WEBHOOK_URL: string;
  readonly VITE_ELEVENLABS_AGENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// The ElevenLabs convai widget ships no type declarations — it's a side-effecting import that
// registers the <elevenlabs-convai> custom element.
declare module '@elevenlabs/convai-widget-embed';
