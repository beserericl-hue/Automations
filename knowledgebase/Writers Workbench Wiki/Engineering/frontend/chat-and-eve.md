---
name: Chat + Eve (frontend)
description: ChatDrawer (text) + Eve widget (voice) + their SSE wiring + session lifecycle.
type: concept
tags: [frontend, chat, eve, sse]
last_reviewed: 2026-05-09
---

# Chat + Eve

Two coexisting surfaces. ChatDrawer is text; Eve is voice. Both call the same n8n hub.

## ChatDrawer

[`client/src/components/chat/ChatDrawer.tsx`](../../../../writers-workbench/client/src/components/chat/ChatDrawer.tsx). Sprint 4 rewrite (S4-6) added:

- **Resizable** — drag handle 360-800px width.
- **Persistent history** — `localStorage` cap 100 msgs.
- **Message timestamps** — relative ("2m ago").
- **Quick Commands panel** — 8 standard commands. Context-aware (if on `/projects/:id`, shows "Write next chapter of [project]").
- **Async detection** — submit produces a Queued pill; detects async ops by classifier output.
- **Typing indicator** — animated 3 bouncing dots.
- **Clear history** button.
- **Auto-grow textarea**.

Job pill states (Sprint 10b-3):
- **Queued** — server returned `{jobId, status:'queued'}`.
- **Processing** — SSE event `{type:'job-status', status:'active'}`.
- **Complete** — SSE `{type:'job-status', status:'completed'}`.
- **Failed** — SSE `{type:'job-status', status:'failed', error?}` → shows toast.

Pill state survives refresh: active job IDs persist in `localStorage.activeJobIds`. On mount, ChatDrawer restores them and subscribes for status updates.

## Submit flow

```ts
async function send() {
  const response = await apiFetch('/api/chat/proxy', {
    method:'POST',
    body: JSON.stringify({user_message_request: text, caller_id: userContext.user.user_id})
  });
  const data = await response.json();

  if (data.jobId) {
    // async — pill state
    setMessages(prev => [...prev, {role:'assistant', type:'pill', jobId:data.jobId, status:'queued'}]);
    addActiveJob(data.jobId);
  } else {
    // sync — full response
    setMessages(prev => [...prev, {role:'assistant', text: data.response}]);
  }
}
```

`apiFetch` automatically adds `Authorization: Bearer <jwt>` and (when impersonating) `X-Impersonate-User`.

## SSE listener wiring

ChatDrawer doesn't open its own EventSource. AppShell maintains a single EventSource and dispatches CustomEvents:

```ts
// AppShell.tsx
useEffect(() => {
  const session = supabase.auth.getSession();
  const url = `/api/callback/events?token=${session.access_token}`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    window.dispatchEvent(new CustomEvent('app-sse', {detail: event}));
  };
  return () => es.close();
}, [session]);
```

ChatDrawer subscribes:

```ts
useEffect(() => {
  const handler = (e: CustomEvent) => {
    if (e.detail.type !== 'job-status') return;
    if (!activeJobIds.includes(e.detail.jobId)) return;
    setMessages(prev => prev.map(m =>
      m.type === 'pill' && m.jobId === e.detail.jobId
        ? {...m, status: e.detail.status, error: e.detail.error}
        : m
    ));
    if (['completed','failed'].includes(e.detail.status)) {
      removeActiveJob(e.detail.jobId);
    }
  };
  window.addEventListener('app-sse', handler);
  return () => window.removeEventListener('app-sse', handler);
}, [activeJobIds]);
```

## Quick Commands

Hardcoded list per Sprint 4 + extended in newsletter sprint. Common ones:

- "List my projects"
- "Show my outlines"
- "Brainstorm a new story in [genre]"
- "Write next chapter of [current project]" (context-aware)
- "Generate cover art for [project]"
- "Show my pending approvals"
- "What's in my library?"
- "Help me edit chapter 7"

Click a command → fills the textarea with the command text → user can edit before submitting.

## Eve widget

[`client/src/components/eve/EveWidget.tsx`](../../../../writers-workbench/client/src/components/eve/EveWidget.tsx). Hosts the `<elevenlabs-convai>` embed.

```tsx
<elevenlabs-convai agent-id={env.VITE_ELEVENLABS_AGENT_ID} />
```

`VITE_ELEVENLABS_AGENT_ID` differs by tier:
- DEV: `agent_0001kpr667v6ffctex0a8dt4fk71`
- PROD: `agent_2801kks580vnf5q80j3bd0n0x45v`

The CDN script is loaded once in `index.html`:

```html
<script src="https://unpkg.com/@elevenlabs/convai-widget-embed" type="module"></script>
```

## Session register/unregister

On widget mount:

```ts
useEffect(() => {
  apiFetch('/api/session/register', {method:'POST'});
  return () => apiFetch('/api/session/unregister', {method:'DELETE'});
}, []);
```

This is what tells n8n's `Sub - Eve Knowledge Callback` "this user has a web session — push SSE instead of phone call."

## Eve UI (sidebar)

`EveOrb` in the sidebar opens a popover containing the `EveWidget`. Popover stays open across page navigation. User can keep talking while clicking around.

`role="dialog"` + `aria-label` on the widget for accessibility.

## Eve callback events

When n8n calls `/api/callback/content-ready` (web mode), AppShell's SSE listener receives:

```json
{"type":"content-ready", "content_id":"...", "content_type":"chapter", "title":"Chapter 7"}
```

AppShell action:
- Show toast: "Eve loaded Chapter 7"
- `queryClient.invalidateQueries(['dashboard'])`
- `queryClient.invalidateQueries(['content'])`

User can navigate to `/library` and see the new chapter immediately.

## Other SSE event types

| Type | Source | Effect |
|------|--------|--------|
| `content-ready` | n8n callback | Toast + invalidate |
| `job-status` | BullMQ events | ChatDrawer pill updates |
| `newsletter:approval-changed` | server (after approval token POST) | NewsletterApprovals updates |
| `newsletter:execution-status` | n8n compose stages | ExecutionStatus live progress |
| `eve:loaded` | n8n callback (web mode) | Notify chat that Eve has KB-loaded the content |

`useNewsletterEvents` hook abstracts the newsletter-specific events.

## ChatDrawer width persistence

```ts
const [width, setWidth] = useState(() => Number(localStorage.getItem('chatDrawerWidth')) || 480);
useEffect(() => { localStorage.setItem('chatDrawerWidth', String(width)); }, [width]);
```

Drag handle uses pointer events for smooth resize.

## Common gotchas

- **EventSource can't set Authorization header** — that's why we pass `?token=` in the URL. Server validates the token from the query.
- **EventSource timeout on Railway is 10 minutes** — for heavy ops that exceed this, the connection drops and the client must reconnect. ChatDrawer reconnects on close.
- **Two open tabs = two SSE connections** — both receive every event. ChatDrawer dedups by jobId; both tabs update.
- **Eve widget loads asynchronously** — `<elevenlabs-convai>` becomes a custom element after the script loads. If you check `document.querySelector('elevenlabs-convai')` immediately after mount, it's not ready. Use the `convai:ready` event.
- **Quitting + reopening Eve mid-conversation** disconnects the WebRTC stream. Eve resumes from agent state but voice tone may shift.
- **`@elevenlabs/react`** does NOT work — abandoned. CDN embed only.
