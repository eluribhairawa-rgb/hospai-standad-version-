"""Every page reachable from the app loads for an admin, without JavaScript errors,
failed API calls, error toasts or a blank body."""
import pytest

from pages.base import BasePage

PAGES = [
    "dashboard", "analytics", "patient-reach-ai", "reach-survey-management", "reach-survey-templates",
    "reach-whatsapp-templates", "reach-survey-reports", "patients", "add", "op-queue-management",
    "doctor-prescription", "patient-journey", "op-desk", "readmit", "doctors-history", "emergency-worklist",
    "ip-admission", "bed-management", "inpatient-patients", "nurse-station", "discharge-summary",
    "pharmacy-overview", "pharmacy-op-dispense", "pharmacy-ip-dispense", "pharmacy-inventory",
    "pharmacy-purchases", "pharmacy-suppliers", "pharmacy-reports", "pharmacy-settings",
    "diag-overview", "diag-orders-billing", "diag-laboratory", "diag-imaging", "diag-reports-approval",
    "diag-reports-history", "diag-quality-equipment", "diag-catalogue", "billing-overview",
    "billing-patient-bills", "billing-ip-discharge", "billing-advances-refunds", "billing-doctor-payouts",
    "billing-reports-day-close", "billing-insurance-claims", "employees", "settings", "admin",
    "accounts-overview", "accounts-ledger", "accounts-vendor-payments", "hrms", "ot", "consent-desk", "insurance-desk",
]


@pytest.mark.smoke
@pytest.mark.parametrize("page_id", PAGES)
def test_page_loads_cleanly(driver, config, page_id):
    page = BasePage(driver, config["base_url"])
    page.open(page_id)
    console = [e["message"] for e in driver.get_log("browser") if e["level"] == "SEVERE"]
    assert driver.current_url.rstrip("/").endswith("/" + page_id), f"redirected to {driver.current_url}"
    assert len(page.main_text()) > 80, "page body is (nearly) blank"
    assert not page.error_toasts(), f"error toast: {page.error_toasts()}"
    assert not console, "browser console errors:\n" + "\n".join(console)
