

# --- optional_int (H8) -------------------------------------------------------------------------


def test_optional_int_parses_numbers() -> None:
    from writer_engine.library_helpers import optional_int

    assert optional_int(3) == 3
    assert optional_int("3") == 3
    assert optional_int(" 12 ") == 12
    assert optional_int(-1) == -1
    assert optional_int(0) == 0
    assert optional_int(3.7) == 3


def test_optional_int_returns_none_for_absent_or_unparseable() -> None:
    from writer_engine.library_helpers import optional_int

    for value in (None, "", "   ", "abc", "chapter three", [], {}):
        assert optional_int(value) is None, value


def test_optional_int_rejects_bools() -> None:
    """bool is an int subclass; True must not become chapter 1."""
    from writer_engine.library_helpers import optional_int

    assert optional_int(True) is None
    assert optional_int(False) is None


def test_optional_int_differs_from_normalize_on_absence() -> None:
    """The reason both exist: defaulting a missing selector to 1 would act on the wrong row.

    normalize_chapter_number defaults to 1 (right for writing), optional_int returns None (right
    for selecting a chapter or version to read/revert).
    """
    from writer_engine.library_helpers import normalize_chapter_number, optional_int

    assert normalize_chapter_number(None) == 1
    assert optional_int(None) is None
    assert normalize_chapter_number("nonsense") == 1
    assert optional_int("nonsense") is None
