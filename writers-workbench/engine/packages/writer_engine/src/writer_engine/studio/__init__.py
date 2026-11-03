"""The Content Studio: review radar drafts, publish or schedule them, and choose a newsletter issue's posts.

The port of the two n8n chat studios (``Content - AI & MVP Content Studio (Workflow B)``
fTRYiQOaQgdAmu7w and ``Content - AI Dev Roundup (Social Studio)`` y0vIznzMeiGoxouX), their queue
manager (``Sub - Manage Scheduled Posts`` HgRagIb4C3klIJa0), the email tools and the weekly digest.

* :mod:`.core`     — which editions are studio editions (owner + radar), the slate, posts, state changes
  and scheduling.
* :mod:`.drafting` — generate drafts from slate topics, revise with an instruction, regenerate.
* :mod:`.issue`    — the posts / topics chosen for an edition's next issue, and the newsletter saga's
  use of them.
* :mod:`.commands` — the assistant's deterministic command grammar ("generate 1-5, 8", "cancel #4").
* :mod:`.emailing` — email a draft, email the slate digest.

Everything is scoped by the caller's ``user_id`` and an edition the caller owns; a studio edition is
private to its owner.
"""
