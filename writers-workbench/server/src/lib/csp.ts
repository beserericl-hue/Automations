/**
 * The app's Content-Security-Policy directives (on top of helmet's defaults).
 *
 * What the browser may load or connect to, beyond our own origin — see the notes on each:
 *   - Supabase   auth + realtime + storage images AND audio (the audiobook recordings are played from
 *                short-lived signed Supabase Storage URLs, which `media-src` must allow or every
 *                player on the Publish page fails with no error in the UI)
 *   - ElevenLabs ConvAI widget ("Talk to Eve"): script from unpkg, connects to *.elevenlabs.io
 *   - Google Fonts (googleapis css + gstatic fonts): covered by style-src/font-src https:
 *
 * helmet()'s default policy sets `default-src 'self'` with NO `connect-src`, which blocked the SPA
 * from reaching Supabase Auth ("Refused to connect ... violates the document's Content Security
 * Policy"), hence the explicit lists.
 */
export const CSP_DIRECTIVES: Record<string, string[]> = {
  'connect-src': [
    "'self'",
    'https://*.supabase.co',
    'wss://*.supabase.co',
    'https://*.elevenlabs.io',
    'wss://*.elevenlabs.io',
  ],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  // 'blob:' + 'wasm-unsafe-eval' are required by the ElevenLabs ConvAI widget ("Talk to Eve"):
  // it loads its rawAudioProcessor AudioWorklet from a blob: URL (Chrome enforces script-src for
  // AudioWorklet.addModule, NOT worker-src — this is why Eve failed on Chrome/PC with
  // "Failed to load the rawAudioProcessor worklet module" while working on other browsers) and
  // compiles a WASM audio module. Without these the widget throws and voice never initialises.
  'script-src': ["'self'", 'blob:', "'wasm-unsafe-eval'", 'https://unpkg.com', 'https://*.elevenlabs.io'],
  // data: is the voice preview (a base64 clip); https://*.supabase.co is every audiobook recording.
  'media-src': ["'self'", 'blob:', 'data:', 'https://*.supabase.co', 'https://*.elevenlabs.io'],
  'frame-src': ["'self'", 'https://*.elevenlabs.io'],
  'worker-src': ["'self'", 'blob:', 'https://*.elevenlabs.io'],
  'font-src': ["'self'", 'https:', 'data:'],
  'style-src': ["'self'", 'https:', "'unsafe-inline'"],
};
