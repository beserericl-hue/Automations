"""J3 — the written prose becomes retrievable canon, not just the plan.

`build_canon_chunks` indexes the outline and the bible, so retrieval returned what a chapter was
SUPPOSED to contain and never what it said. Measured on The Burial Mound: chapter 50 was written
knowing chapter 49's one-line brief, not its prose. Cross-chapter continuity rested on the outline
plus `bridge_from_prior` — which held across 96 chapters of an unusually detailed outline, and
would not hold for a thin one. This is the substance of I3.
"""

from __future__ import annotations

from writer_engine.embeddings import PROSE_DOC_TYPE, build_prose_chunks

SCENE_BREAK = "\n\n---\n\n"


def _words(n: int, w: str = "word") -> str:
    return " ".join([w] * n)


# --- granularity -------------------------------------------------------------------------------


def test_a_chapter_is_chunked_per_scene_not_as_one_blob() -> None:
    """A 7k-word chapter embedded as ONE vector averages everything and retrieves nothing."""
    text = SCENE_BREAK.join([_words(400, "alpha"), _words(400, "beta"), _words(400, "gamma")])
    chunks = build_prose_chunks(chapter_number=6, title="The Inmost Cave", text=text)
    assert len(chunks) == 3
    assert all(c["doc_type"] == PROSE_DOC_TYPE for c in chunks)
    assert [c["doc_id"] for c in chunks] == ["ch_6_s1", "ch_6_s2", "ch_6_s3"]


def test_each_chunk_says_which_chapter_and_scene_it_is_from() -> None:
    """The retrieved text lands in a prompt with no surrounding context, so it has to self-identify."""
    chunks = build_prose_chunks(chapter_number=12, title="Millhaven", text=_words(300))
    assert "chapter 12" in chunks[0]["content"]
    assert "Millhaven" in chunks[0]["content"]
    assert "Ch 12" in chunks[0]["doc_title"]


def test_a_pre_a13_chapter_with_no_separators_is_windowed() -> None:
    """All 96 Burial Mound chapters predate A13 and contain zero scene breaks.

    Without a fallback they would each be one 7k-word chunk — the exact uselessness this avoids.
    """
    text = "\n\n".join(_words(200) for _ in range(10))  # 2000 words, no separators
    chunks = build_prose_chunks(chapter_number=40, title="Ahanu and the Rain", text=text, window_words=400)
    assert len(chunks) >= 4
    assert all(len(c["content"].split()) < 700 for c in chunks)


def test_windows_do_not_split_a_paragraph() -> None:
    """A sentence cut in half embeds badly and reads worse if it is ever shown."""
    paras = [f"Paragraph {i} " + _words(150) for i in range(8)]
    chunks = build_prose_chunks(chapter_number=1, title="t", text="\n\n".join(paras), window_words=400)
    joined = " ".join(c["content"] for c in chunks)
    for i in range(8):
        assert f"Paragraph {i}" in joined


def test_scene_split_wins_over_windowing_when_separators_exist() -> None:
    """Post-A13 chapters carry real scene boundaries; those beat an arbitrary word count."""
    text = SCENE_BREAK.join([_words(900, "alpha"), _words(900, "beta")])
    chunks = build_prose_chunks(chapter_number=2, title="t", text=text, window_words=400)
    assert len(chunks) == 2  # two scenes, not five windows
    assert "alpha" in chunks[0]["content"] and "beta" in chunks[1]["content"]


# --- edges -------------------------------------------------------------------------------------


def test_an_empty_chapter_yields_nothing() -> None:
    for text in ("", "   ", "\n\n"):
        assert build_prose_chunks(chapter_number=1, title="t", text=text) == []


def test_a_missing_title_is_tolerated() -> None:
    chunks = build_prose_chunks(chapter_number=3, title="", text=_words(100))
    assert chunks
    assert "Ch 3" in chunks[0]["doc_title"]


def test_doc_ids_are_scoped_per_chapter_so_a_refresh_cannot_cross_chapters() -> None:
    """index_chapter_prose deletes `ch_<n>_s%`, so the ids must not collide across chapters."""
    a = {c["doc_id"] for c in build_prose_chunks(chapter_number=1, title="t", text=_words(100))}
    b = {c["doc_id"] for c in build_prose_chunks(chapter_number=11, title="t", text=_words(100))}
    assert a.isdisjoint(b)
    assert all(d.startswith("ch_1_s") for d in a)
    assert all(d.startswith("ch_11_s") for d in b)
