"""Fixtures: environment-based config, logged-in Chrome session, failure screenshots and
browser console capture. Run against the disposable stack from e2e/stack.sh only."""
import os
import pathlib

import pytest
from selenium import webdriver

from pages.base import LoginPage

REPORTS = pathlib.Path(__file__).parent / "reports"


def _env(name):
    value = os.environ.get(name)
    if not value:
        pytest.exit(f"{name} is not set -- run `source <E2E_WORK>/stack.env` after `e2e/stack.sh up`", 2)
    return value


@pytest.fixture(scope="session")
def config():
    db_url = _env("E2E_DATABASE_URL")
    if "test" not in db_url.rsplit("/", 1)[-1]:
        pytest.exit("refusing to run: E2E_DATABASE_URL must point at a database whose name contains 'test'", 2)
    return {"base_url": _env("E2E_BASE_URL").rstrip("/"), "user": _env("E2E_ADMIN_USERNAME"),
            "password": _env("E2E_ADMIN_PASSWORD"), "db_url": db_url}


@pytest.fixture(scope="session")
def driver(config):
    opts = webdriver.ChromeOptions()
    if os.environ.get("E2E_HEADLESS", "1") != "0":
        opts.add_argument("--headless=new")
    for arg in ("--window-size=1440,900", "--no-sandbox"):
        opts.add_argument(arg)
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    drv = webdriver.Chrome(options=opts)
    LoginPage(drv, config["base_url"]).login(config["user"], config["password"])
    drv.get_log("browser")  # discard login-time noise
    yield drv
    drv.quit()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    drv = item.funcargs.get("driver")
    if rep.when == "call" and rep.failed and drv is not None:
        REPORTS.mkdir(exist_ok=True)
        shot = REPORTS / f"{item.name.replace('/', '_')}.png"
        drv.save_screenshot(str(shot))
        rep.sections.append(("screenshot", str(shot)))
