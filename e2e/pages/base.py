"""Page objects shared by all suites."""
import time

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


class BasePage:
    def __init__(self, driver, base_url, timeout=20):
        self.driver, self.base_url, self.wait = driver, base_url, WebDriverWait(driver, timeout)

    def open(self, page_id):
        self.driver.get(f"{self.base_url}/{page_id}")
        self.wait.until(lambda d: d.execute_script("return document.readyState") == "complete")
        time.sleep(1.5)  # let the page's initial API calls settle before inspecting it

    def error_toasts(self):
        return [t.text for t in self.driver.find_elements(By.CSS_SELECTOR, ".toast.error, .toast.warning")]

    def main_text(self):
        return self.driver.execute_script("return ((document.querySelector('main')||document.body).innerText||'').trim()")


class LoginPage(BasePage):
    def login(self, username, password):
        self.driver.get(f"{self.base_url}/")
        self.wait.until(EC.presence_of_element_located((By.NAME, "username"))).send_keys(username)
        self.driver.find_element(By.NAME, "password").send_keys(password)
        self.driver.find_element(By.CSS_SELECTOR, "form.login-form button[type=submit]").click()
        self.wait.until(EC.url_contains("/dashboard"))
