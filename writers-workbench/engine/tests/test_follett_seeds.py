"""Follett craft prompt layer — every documented key present, composition order correct.

The vault pages (knowledgebase/Writers Workbench Wiki/Writing Craft/*) declare exact prompt_store
keys per fragment + which step consumes them. These lock the engine port to that contract so a
renamed/missing seed fails CI rather than silently dropping craft guidance from generation.
"""

from __future__ import annotations

import pytest

from writer_engine.prompt_store import (
    FOLLETT_SEEDS,
    compose_craft_system,
    get_prompt_store,
    seed_default_prompts,
)
from writer_engine.prompt_store.follett_seeds import load_follett_seeds

# The keys the vault pages declare in their "Engine integration" tables.
EXPECTED_KEYS = {
    "follett_seeds.prime_directive",
    # character-development.md
    "follett_seeds.character.broad_strokes_then_twist",
    "follett_seeds.character.life_outside_plot",
    "follett_seeds.character.pov_selector",
    "follett_seeds.character.locked_roster",
    "follett_seeds.character.good_guy_humanizer",
    "follett_seeds.character.moral_complication",
    "follett_seeds.character.no_milk_and_water",
    # plot-and-narrative-structure.md
    "follett_seeds.plot.dramatic_question",
    "follett_seeds.plot.outline_gate",
    "follett_seeds.plot.scene_density",
    "follett_seeds.plot.weaving",
    "follett_seeds.plot.anti_sog",
    "follett_seeds.plot.heightened_ending",
    "follett_seeds.plot.wow_factor",
    # scene-pace-and-story-turns.md
    "follett_seeds.scene.event_list",
    "follett_seeds.scene.ups_and_downs",
    "follett_seeds.scene.bme_check",
    "follett_seeds.scene.turn_density",
    "follett_seeds.scene.escalating_turn",
    "follett_seeds.scene.info_as_drama",
    "follett_seeds.scene.description",
    "follett_seeds.scene.pov_bridge",
    "follett_seeds.scene.fix_now",
    # research-and-local-color.md
    "follett_seeds.research.derive",
    "follett_seeds.research.perplexity_query",
    "follett_seeds.research.scene_seed",
    "follett_seeds.research.no_dumping",
    "follett_seeds.research.period_language",
    "follett_seeds.research.expert_protocol",
    "follett_seeds.research.setback_opportunity",
    "follett_seeds.research.local_color",
    # prose-style-dialogue-set-pieces.md
    "follett_seeds.prose.transparent",
    "follett_seeds.prose.diction",
    "follett_seeds.prose.first_line",
    "follett_seeds.prose.dialogue",
    "follett_seeds.prose.intimacy",
    "follett_seeds.prose.action",
    "follett_seeds.prose.daily_rewrite",
    "follett_seeds.prose.no_boring",
}


def test_all_documented_keys_present_and_nonempty() -> None:
    assert set(FOLLETT_SEEDS) >= EXPECTED_KEYS, (
        "missing craft seeds: " + ", ".join(sorted(EXPECTED_KEYS - set(FOLLETT_SEEDS)))
    )
    for key in EXPECTED_KEYS:
        assert FOLLETT_SEEDS[key].strip(), f"{key} is empty"


def test_loaded_into_prompt_store() -> None:
    load_follett_seeds()
    store = get_prompt_store()
    assert "reader must share in the emotions" in store.get("follett_seeds.prime_directive")
    assert "off-axis attribute" in store.get("follett_seeds.character.broad_strokes_then_twist")


def test_seed_default_prompts_includes_follett() -> None:
    # The aggregate seeder must register the craft layer too.
    seed_default_prompts()
    store = get_prompt_store()
    assert store.get("follett_seeds.plot.outline_gate").startswith("You have produced an outline")


def test_compose_layers_in_order() -> None:
    load_follett_seeds()
    out = compose_craft_system(
        seed_keys=["follett_seeds.scene.bme_check"],
        genre_block="GENRE: post-apocalyptic survival.",
        arc_block="ARC: Freytag's pyramid.",
    )
    i_prime = out.index("reader must share")
    i_genre = out.index("GENRE:")
    i_arc = out.index("ARC:")
    i_seed = out.index("BEGINNING")
    assert i_prime < i_genre < i_arc < i_seed  # prime -> genre -> arc -> seeds


def test_compose_unknown_key_fails_loud() -> None:
    with pytest.raises(KeyError):
        compose_craft_system(seed_keys=["follett_seeds.does_not_exist"])
