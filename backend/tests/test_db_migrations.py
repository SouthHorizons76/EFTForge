"""Check the schema migration runner and the tarkov.db column sync against throwaway
SQLite files, so they run on CI without any real database."""

import os
import sqlite3
import threading

import pytest
from sqlalchemy import create_engine

os.environ.setdefault("IP_HASH_SECRET", "migration-test-secret")
os.environ.setdefault("ADMIN_API_KEY", "migration-test-admin")

import db_migrations  # noqa: E402
import models_builds  # noqa: E402,F401 - registers the builds tables
import models_item_offers  # noqa: E402,F401
import models_items  # noqa: E402,F401
import models_slots  # noqa: E402,F401
from database import Base  # noqa: E402
from database_builds import BuildsBase  # noqa: E402

# Every column the old hand-written tarkov.db upgrades added, so the model column
# sync is held to at least what they covered.
OLD_ITEM_COLUMNS = """task_unlock_id task_unlock_name task_unlock_name_zh sighting_range bare_image_512_link
accuracy_modifier base_image_link ammo_damage penetration_power armor_damage velocity tracer tracer_color ammo_type
projectile_count fragmentation_chance ricochet_chance stack_max_size ammo_accuracy_modifier ammo_recoil_modifier
light_bleed_delta heavy_bleed_delta penetration_chance penetration_power_deviation heat_factor cooling_factor
durability_burn_factor velocity_modifier loudness category_ids attachment_category attachment_category_zh fire_rate
recoil_damping_hand_rot recoil_return_path_damping recoil_return_path_offset recoil_stable_index_shot
recoil_stable_angle_step recoil_stable_angle recoil_pos_z_mult recoil_center_y recoil_center_z
penetration_damage_mod malf_feed_chance misfire_chance""".split()


def _columns(path, table):
    with sqlite3.connect(path) as conn:
        return {row[1]: row for row in conn.execute(f"PRAGMA table_info({table})")}


def _indexes(path):
    with sqlite3.connect(path) as conn:
        return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}


def _legacy_builds_db(path):
    # The tables as an early release created them, before any of the baseline columns.
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE public_builds (id INTEGER PRIMARY KEY, ip_hash TEXT, build_name TEXT);
            CREATE TABLE server_announcements (id INTEGER PRIMARY KEY, message TEXT);
            CREATE TABLE build_comments (id INTEGER PRIMARY KEY, ip_hash TEXT, body TEXT);
            CREATE TABLE build_votes (id INTEGER PRIMARY KEY, created_at DATETIME);
            INSERT INTO public_builds (ip_hash, build_name) VALUES ('h', 'old build');
            INSERT INTO server_announcements (message) VALUES ('hello');
            """)


def test_pending_migrations_run_in_order_once(tmp_path):
    path = str(tmp_path / "x.db")
    sqlite3.connect(path).close()
    ran = []
    migrations = [lambda conn: ran.append(1), lambda conn: ran.append(2)]
    assert db_migrations.run_migrations(path, migrations) == 2
    assert db_migrations.run_migrations(path, migrations) == 2
    assert ran == [1, 2]

    migrations.append(lambda conn: ran.append(3))
    assert db_migrations.run_migrations(path, migrations) == 3
    assert ran == [1, 2, 3]
    assert db_migrations.schema_version(path) == 3


def test_failed_migration_rolls_back_its_changes_and_version(tmp_path):
    path = str(tmp_path / "x.db")
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)")

    def first(conn):
        db_migrations.add_column(conn, "t", "a", "TEXT")

    def broken(conn):
        db_migrations.add_column(conn, "t", "b", "TEXT")
        conn.execute("INSERT INTO t (id) VALUES (1)")
        raise RuntimeError("boom")

    never = []
    with pytest.raises(RuntimeError):
        db_migrations.run_migrations(path, [first, broken, lambda conn: never.append(1)])
    assert db_migrations.schema_version(path) == 1
    assert set(_columns(path, "t")) == {"id", "a"}
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0
    assert never == []


def test_database_from_a_newer_build_is_left_alone(tmp_path):
    path = str(tmp_path / "x.db")
    db_migrations.stamp(path, 5)
    ran = []
    assert db_migrations.run_migrations(path, [lambda conn: ran.append(1)]) == 5
    assert ran == [] and db_migrations.schema_version(path) == 5


def test_builds_baseline_upgrades_a_legacy_database_and_keeps_its_rows(tmp_path):
    path = str(tmp_path / "builds.db")
    _legacy_builds_db(path)
    assert db_migrations.run_migrations(path, db_migrations.BUILDS_MIGRATIONS) == len(db_migrations.BUILDS_MIGRATIONS)

    builds = _columns(path, "public_builds")
    assert {"ammo_id", "is_rotating", "user_display_name", "user_avatar_url", "tags_json"} <= set(builds)
    assert {"game", "loadout_json"} <= set(builds)
    assert builds["is_rotating"][4] == "0"  # dflt_value
    assert _columns(path, "server_announcements")["dismissible"][4] == "1"
    assert {"user_display_name", "user_avatar_url"} <= set(_columns(path, "build_comments"))
    assert {"ix_public_builds_ip_hash", "ix_build_vote_created_at", "ix_build_comments_ip_hash"} <= _indexes(path)
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT build_name, is_rotating FROM public_builds").fetchall() == [("old build", 0)]
        assert conn.execute("SELECT dismissible FROM server_announcements").fetchall() == [(1,)]


def test_builds_baseline_is_a_no_op_on_the_current_schema(tmp_path):
    path = str(tmp_path / "builds.db")
    BuildsBase.metadata.create_all(create_engine(f"sqlite:///{path}"))
    before = {t: _columns(path, t) for t in ("public_builds", "server_announcements", "build_comments")}
    db_migrations.run_migrations(path, db_migrations.BUILDS_MIGRATIONS)
    assert {t: _columns(path, t) for t in before} == before


@pytest.fixture
def startup(tmp_path, monkeypatch):
    # Point prepare_databases at throwaway files instead of the app's databases.
    tarkov = create_engine(f"sqlite:///{tmp_path / 'tarkov.db'}")
    builds = create_engine(f"sqlite:///{tmp_path / 'builds.db'}")
    monkeypatch.setattr(db_migrations, "engine", tarkov)
    monkeypatch.setattr(db_migrations, "RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(db_migrations, "_VERSIONED", ((builds, BuildsBase, db_migrations.BUILDS_MIGRATIONS),))
    return tmp_path


def test_new_database_is_stamped_current_without_running_migrations(startup, monkeypatch):
    ran = []
    monkeypatch.setattr(
        db_migrations, "_VERSIONED", ((db_migrations._VERSIONED[0][0], BuildsBase, [ran.append, ran.append]),)
    )
    statuses = []
    db_migrations.prepare_databases(status=statuses.append)
    assert db_migrations.schema_version(str(startup / "builds.db")) == 2
    assert ran == []
    assert statuses == ["preparing_database", "applying_updates"]
    assert "is_rotating" in _columns(str(startup / "builds.db"), "public_builds")


def test_existing_database_is_migrated_at_startup(startup):
    _legacy_builds_db(str(startup / "builds.db"))
    db_migrations.prepare_databases()
    assert db_migrations.schema_version(str(startup / "builds.db")) == len(db_migrations.BUILDS_MIGRATIONS)
    assert "tags_json" in _columns(str(startup / "builds.db"), "public_builds")
    # Tables the legacy file never had are created alongside.
    assert _columns(str(startup / "builds.db"), "pending_notifications")


def test_tarkov_db_gains_every_model_column_it_lacks(tmp_path):
    path = str(tmp_path / "tarkov.db")
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE items (id VARCHAR PRIMARY KEY, name VARCHAR);
            CREATE TABLE slots (id VARCHAR PRIMARY KEY, item_id VARCHAR);
            CREATE TABLE item_offers (id INTEGER PRIMARY KEY);
            INSERT INTO slots (id, item_id) VALUES ('s', 'i');
            """)
    added = db_migrations.sync_model_columns(create_engine(f"sqlite:///{path}"), Base.metadata)

    items = _columns(path, "items")
    assert set(OLD_ITEM_COLUMNS) <= set(items)
    assert set(Base.metadata.tables["items"].columns.keys()) <= set(items)
    assert {"slot_game_name", "required"} <= set(_columns(path, "slots"))
    assert "game_mode" in _columns(path, "item_offers")
    # The model's Python default reaches rows that were already there.
    assert _columns(path, "slots")["required"][4] == "0"
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT required FROM slots").fetchall() == [(0,)]
    assert "ix_item_offers_game_mode" in _indexes(path)
    assert "items.misfire_chance" in added
    # Nothing left to do the second time.
    assert db_migrations.sync_model_columns(create_engine(f"sqlite:///{path}"), Base.metadata) == []


def test_schema_lock_admits_one_holder_at_a_time(tmp_path, monkeypatch):
    monkeypatch.setattr(db_migrations, "RUNTIME_DIR", str(tmp_path))
    holding, release, second_in = threading.Event(), threading.Event(), threading.Event()

    def first():
        with db_migrations.schema_lock():
            holding.set()
            release.wait(5)

    def second():
        holding.wait(5)
        with db_migrations.schema_lock():
            second_in.set()

    threads = [threading.Thread(target=first), threading.Thread(target=second)]
    for t in threads:
        t.start()
    assert holding.wait(5)
    assert not second_in.wait(0.3)
    release.set()
    assert second_in.wait(5)
    for t in threads:
        t.join(5)
