import pytest


@pytest.fixture(autouse=True)
def _never_spawn_a_real_brain(monkeypatch):
    """server.lifespan builds the brain but must not start `claude` under test."""
    monkeypatch.setenv("JARVIS_BRAIN_AUTOSTART", "0")


@pytest.fixture(autouse=True)
def _never_post_a_real_notification(monkeypatch, request):
    """No test may spam the developer's Notification Centre.

    Patched on the `notifier` module object itself rather than on `server`, so
    the `importlib.reload(server_module)` that several test fixtures do cannot
    hand the real implementation back. test_notifier.py is exempt: it tests
    notify() itself and mocks the subprocess boundary directly.
    """
    if request.module.__name__.endswith("test_notifier"):
        return
    import notifier

    async def _blocked(*args, **kwargs):
        raise AssertionError("a test tried to post a real macOS notification; "
                             "mock notifier.notify")

    monkeypatch.setattr(notifier, "notify", _blocked)


@pytest.fixture(autouse=True)
def _never_touch_the_real_projects_folder(monkeypatch, tmp_path):
    """No test may create a directory in the user's real ~/Projects.

    `create_project` writes into JARVIS_PROJECTS_DIR (default ~/Projects) and
    will create that root if it is missing, so the default is redirected into
    a tmp_path for every test — the same reasoning as JARVIS_DATA_DIR. A test
    that wants its own root still sets the variable itself; this only fills in
    a safe default.
    """
    monkeypatch.setenv("JARVIS_PROJECTS_DIR", str(tmp_path / "projects-root"))


@pytest.fixture(autouse=True)
def _never_write_to_the_live_dotenv(monkeypatch, tmp_path):
    """No test may write into the developer's live `.env`.

    Found the hard way: the settings endpoints write straight into the
    repository's own .env, so a test that posted a preference silently
    rewrote the developer's real configuration — and a test written to
    prove `.env` line injection injected the line for real. Same reasoning
    as JARVIS_DATA_DIR; a test that wants its own file still sets the
    variable itself.
    """
    monkeypatch.setenv("JARVIS_ENV_FILE", str(tmp_path / "dotenv" / ".env"))


@pytest.fixture(autouse=True)
def _never_write_to_the_live_data_dir(monkeypatch, tmp_path):
    """No test may write into the user's real `data/`.

    Most tests already set JARVIS_DATA_DIR (and still do — this only fills in
    a safe default), but a test that merely drives the brain writes there too
    now that a rate-limit event is persisted: without this, running the suite
    overwrote the live usage reading with a fixture's fake one.
    """
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path / "data-dir"))
