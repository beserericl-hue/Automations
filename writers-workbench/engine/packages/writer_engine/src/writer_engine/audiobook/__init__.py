"""Audiobook narration: chapter text -> expressive speech -> a mastered, retail-spec MP3 per chapter.

``text``    chapter prose -> speech chunks and pauses
``styles``  the narrator's direction (what keeps the voice from sounding flat)
``tts``     one call to the speech provider
``master``  ffmpeg: join, level to the loudness window, limit the peaks, encode 192 kbps CBR
``build``   one recording end to end: read the row, narrate, master, store, record
"""
