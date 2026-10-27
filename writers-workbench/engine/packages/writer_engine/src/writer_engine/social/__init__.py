"""The post calendar and its publisher: the engine's port of the n8n blog / LinkedIn posting system.

* :mod:`writer_engine.social.channels` — the request for each channel, and the calls that send it.
* :mod:`writer_engine.social.schedule` — putting posts on the calendar (slots, numbering, de-dupe).
* :mod:`writer_engine.social.poster`   — the cron tick that posts due rows (dry run unless
  ``SOCIAL_POSTING_MODE=live``).
"""
