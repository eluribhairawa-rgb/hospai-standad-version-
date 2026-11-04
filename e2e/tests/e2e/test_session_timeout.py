"""Inactivity timeout in a real browser: warning + continue, idle logout, staying signed
in while active, server-side expiry, and single login per employee.

Needs the disposable stack started with a short timeout so idle waits take ~2 minutes:

    E2E_SESSION_TTL_MINUTES=2 e2e/stack.sh up && source <E2E_WORK>/stack.env
    cd e2e && ../backend/.venv/bin/python -m pytest tests/e2e/test_session_timeout.py -v

With a 2-minute timeout the warning appears after 1 minute (lead = min(2 min, timeout / 2)).
"""
import os
import time

import psycopg2
import pytest
from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from pages.base import LoginPage

TTL_MINUTES = float(os.environ.get("E2E_SESSION_TTL_MINUTES", "20"))
TTL_S = TTL_MINUTES * 60
WARNING_LEAD_S = min(120, TTL_S / 2)

pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(TTL_MINUTES > 3, reason="start the stack with E2E_SESSION_TTL_MINUTES<=3 to run idle-timeout tests"),
]

WARNING = (By.CSS_SELECTOR, "[data-testid=session-timeout-warning]")
CONTINUE = (By.CSS_SELECTOR, "[data-testid=session-timeout-continue]")


def new_driver():
    opts = webdriver.ChromeOptions()
    if os.environ.get("E2E_HEADLESS", "1") != "0":
        opts.add_argument("--headless=new")
    for arg in ("--window-size=1440,900", "--no-sandbox"):
        opts.add_argument(arg)
    return webdriver.Chrome(options=opts)


@pytest.fixture
def browser(config):
    drv = new_driver()
    LoginPage(drv, config["base_url"]).login(config["user"], config["password"])
    yield drv
    drv.quit()


def interact(drv):
    """A real user interaction (key press) that doesn't change the page."""
    ActionChains(drv).send_keys(Keys.SHIFT).perform()


def on_login_screen(drv):
    return "/login" in drv.current_url and drv.find_elements(By.NAME, "username")


def toast_text(drv):
    return " ".join(t.text for t in drv.find_elements(By.CSS_SELECTOR, ".toast-message"))


def test_warning_appears_and_continue_keeps_session(browser):
    WebDriverWait(browser, TTL_S - WARNING_LEAD_S + 15).until(EC.visibility_of_element_located(WARNING))
    countdown = browser.find_element(By.CSS_SELECTOR, "[data-testid=session-timeout-countdown]").text
    assert ":" in countdown
    browser.find_element(*CONTINUE).click()
    WebDriverWait(browser, 5).until(EC.invisibility_of_element_located(WARNING))
    # Well past the original deadline, the user is still signed in.
    time.sleep(WARNING_LEAD_S + 5)
    assert not on_login_screen(browser), "continuing the session should have reset the idle timer"


def test_idle_user_is_logged_out(browser):
    WebDriverWait(browser, TTL_S + 20).until(lambda d: on_login_screen(d))
    assert "inactivity" in toast_text(browser).lower()
    # The server session is gone too, not just the UI state.
    browser.get(browser.current_url.replace("/login", "/dashboard"))
    WebDriverWait(browser, 15).until(lambda d: on_login_screen(d))


def test_active_user_stays_logged_in(browser):
    deadline = time.time() + TTL_S * 1.5
    while time.time() < deadline:
        interact(browser)
        time.sleep(10)
        assert not on_login_screen(browser), "active user was logged out"
        assert not browser.find_elements(*WARNING) or not browser.find_element(*WARNING).is_displayed()


def test_server_side_expiry_redirects_to_login(browser, config):
    # Server expires the session while the UI still believes it is valid; the next
    # interaction-triggered request must be rejected and land on the login screen.
    with psycopg2.connect(config["db_url"]) as conn, conn.cursor() as cur:
        cur.execute("UPDATE sessions SET expires_at = NOW() AT TIME ZONE 'UTC' - INTERVAL '1 minute' "
                    "WHERE user_id = (SELECT id FROM users WHERE username = %s)", (config["user"],))
    browser.get(browser.current_url.replace("/dashboard", "/patients"))
    WebDriverWait(browser, 20).until(lambda d: on_login_screen(d))


def test_login_on_another_device_signs_out_first(browser, config):
    other = new_driver()
    try:
        LoginPage(other, config["base_url"]).login(config["user"], config["password"])
        # The first browser's next request is rejected.
        browser.get(browser.current_url.replace("/dashboard", "/patients"))
        WebDriverWait(browser, 20).until(lambda d: on_login_screen(d))
        assert not on_login_screen(other)
    finally:
        other.quit()
