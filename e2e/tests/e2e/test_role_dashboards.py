"""Role-based dashboards in a real browser, one fresh login per role.

Creates employees through the Employee Management API as the stack's admin (two
doctors linked to doctor profiles, nurse, receptionist, pharmacist, lab technician,
billing staff and a second admin), seeds appointments for both doctors, then logs in
as each one and checks:
  * admins / super admins still get the executive dashboard, unchanged;
  * every other role gets its own persona, KPI cards, pending tasks, chart and quick
    actions in the same layout, with no error toasts or console errors;
  * quick actions and KPI cards navigate to pages the login can open;
  * a doctor's dashboard lists only that doctor's patients.

    e2e/stack.sh up && source <E2E_WORK>/stack.env
    cd e2e && ../backend/.venv/bin/python -m pytest tests/e2e/test_role_dashboards.py -v
"""
import os
import time
import uuid

import http.cookiejar
import json
import urllib.request

import psycopg2
import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from pages.base import LoginPage

pytestmark = pytest.mark.e2e

TAG = uuid.uuid4().hex[:5]
PASSWORD = "Passw0rd!e2e"
BASE_MODULES = ["dashboard", "patients", "queue-management"]
DR_A, DR_B = f"Dr. E2E Anil {TAG}", f"Dr. E2E Beena {TAG}"

ROLES = {
    # key: (job_role, modules, doctor_name, user_type, expected persona or None for executive)
    "doc_a": ("Doctor", BASE_MODULES + ["doctor-prescription", "doctors-history", "ip-management"], DR_A, "normal", "doctor"),
    "doc_b": ("Doctor", BASE_MODULES, DR_B, "normal", "doctor"),
    "nurse": ("Nurse", BASE_MODULES + ["ip-management", "bed-management"], "", "normal", "nurse"),
    "reception": ("Receptionist", BASE_MODULES + ["patient-registration", "follow-up", "doctor-scheduling"], "", "normal", "receptionist"),
    "pharmacist": ("Technician", ["dashboard", "pharmacy"], "", "normal", "pharmacist"),
    "lab": ("Technician", ["dashboard", "lab-diagnostics"], "", "normal", "lab_technician"),
    "billing": ("Other", ["dashboard", "billing"], "", "normal", "billing"),
    # Expanded Employee Management job titles.
    "pharm_title": ("Pharmacist", ["dashboard", "pharmacy"], "", "normal", "pharmacist"),
    "radiology": ("Radiology Technician", ["dashboard", "lab-diagnostics"], "", "normal", "lab_technician"),
    "billing_exec": ("Billing Executive", ["dashboard", "billing"], "", "normal", "billing"),
    "head_nurse": ("Head Nurse", BASE_MODULES + ["ip-management"], "", "normal", "nurse"),
    # A title never unlocks a module: a Pharmacist without the Pharmacy module gets the basic dashboard.
    "pharm_nomodule": ("Pharmacist", ["dashboard", "patients"], "", "normal", "staff"),
    "admin2": ("Admin", BASE_MODULES, "", "admin", None),
}

EXECUTIVE_MARKERS = ["Monthly Revenue", "Pharmacy Revenue", "Lab Revenue", "Revenue Snapshot (Today)", "Payment Summary (Today)"]


def username(key):
    return f"e2e_{key}_{TAG}".lower()


@pytest.fixture(scope="module")
def seeded(config):
    api = os.environ["E2E_API_URL"].rstrip("/")
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def post(path, body):
        req = urllib.request.Request(f"{api}{path}", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        with opener.open(req) as resp:  # raises on 4xx/5xx
            return json.loads(resp.read() or b"{}")

    post("/api/auth/login", {"username": config["user"], "password": config["password"]})
    for key, (job, modules, doctor, user_type, _) in ROLES.items():
        res = post("/api/employees", {
            "username": username(key), "password": PASSWORD, "full_name": f"E2E {key.title()}",
            "job_role": job, "doctor_name": doctor, "user_type": user_type, "module_access": modules,
        })
        assert res.get("success"), res
    post("/api/auth/logout", {})

    with psycopg2.connect(config["db_url"]) as conn, conn.cursor() as cur:
        for pid, doctor, token in ((f"EA{TAG}", DR_A, 7101), (f"EB{TAG}", DR_B, 7201)):
            cur.execute("INSERT INTO appointments (patient_id, patient_name, visit_type, appointment_date, token_no, status, doctor_name) "
                        "VALUES (%s, %s, 'OP', CURRENT_DATE + TIME '11:00', %s, 'scheduled', %s)",
                        (pid, f"Patient {pid}", token, doctor))
        # One admitted IPD patient (admission + active bed) for the nurse-assignment flow.
        ip_pid = f"EIP{TAG}"
        cur.execute("INSERT INTO patients (patient_id, name, last_name, hospital_id) "
                    "VALUES (%s, 'Ward', %s, (SELECT hospital_id FROM users WHERE username = %s))",
                    (ip_pid, ip_pid, username("nurse")))
        cur.execute("INSERT INTO admissions (patient_id, admission_date, hospital_id) "
                    "SELECT %s, CURRENT_TIMESTAMP, hospital_id FROM users WHERE username = %s RETURNING id",
                    (ip_pid, username("nurse")))
        adm = cur.fetchone()[0]
        cur.execute("INSERT INTO bed_allocations (admission_id, patient_id, ward, bed_no, status) "
                    "VALUES (%s, %s, %s, 'E1', 'active')", (adm, ip_pid, f"E2E Ward {TAG}"))
        cur.execute("INSERT INTO emar_records (patient_id, admission_id, medicine_name, scheduled_time, status) "
                    "VALUES (%s, %s, 'Ceftriaxone', (NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '20 minutes', 'pending')",
                    (ip_pid, adm))
    return {"ip_admission": adm, "ip_patient": ip_pid}


def new_driver():
    opts = webdriver.ChromeOptions()
    if os.environ.get("E2E_HEADLESS", "1") != "0":
        opts.add_argument("--headless=new")
    for arg in ("--window-size=1440,900", "--no-sandbox"):
        opts.add_argument(arg)
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    return webdriver.Chrome(options=opts)


@pytest.fixture
def login_as(config, seeded):
    drivers = []

    def _login(user, password=PASSWORD):
        drv = new_driver()
        drivers.append(drv)
        LoginPage(drv, config["base_url"]).login(user, password)
        WebDriverWait(drv, 20).until(EC.presence_of_element_located((By.CSS_SELECTOR, "section.hosp-dashboard")))
        time.sleep(2)  # let the dashboard's API calls settle
        return drv

    yield _login
    for drv in drivers:
        drv.quit()


def dashboard_text(drv):
    return drv.find_element(By.CSS_SELECTOR, "section.hosp-dashboard").text


def severe_console_errors(drv):
    return [e["message"] for e in drv.get_log("browser") if e["level"] == "SEVERE" and "favicon" not in e["message"]]


def error_toasts(drv):
    return [t.text for t in drv.find_elements(By.CSS_SELECTOR, ".toast.error, .toast.warning")]


@pytest.mark.parametrize("key", ["admin2", "stack_admin"])
def test_admin_dashboards_are_unchanged(login_as, config, key):
    drv = login_as(config["user"], config["password"]) if key == "stack_admin" else login_as(username(key))
    section = drv.find_element(By.CSS_SELECTOR, "section.hosp-dashboard")
    assert section.get_attribute("data-persona") is None  # executive dashboard, not the role one
    text = dashboard_text(drv).lower()  # KPI labels are upper-cased by CSS
    for marker in EXECUTIVE_MARKERS:
        assert marker.lower() in text, marker
    assert len(drv.find_elements(By.CSS_SELECTOR, ".hosp-kpi-row .hosp-kpi-card")) == 6
    assert not error_toasts(drv)


@pytest.mark.parametrize("key", [k for k, v in ROLES.items() if v[4]])
def test_role_dashboard_renders_and_navigates(login_as, config, key):
    persona = ROLES[key][4]
    drv = login_as(username(key))
    section = WebDriverWait(drv, 20).until(
        EC.presence_of_element_located((By.CSS_SELECTOR, f"section.hosp-dashboard[data-persona='{persona}']")))
    WebDriverWait(drv, 20).until(lambda d: d.find_elements(By.CSS_SELECTOR, ".hosp-kpi-row .hosp-kpi-card"))
    text = section.text.lower()
    # No hospital-wide revenue widgets from the executive dashboard.
    for marker in ("Revenue Snapshot (Today)", "Payment Summary (Today)", "Monthly Revenue"):
        assert marker.lower() not in text, marker
    assert "quick actions" in text
    if persona != "staff":  # the basic staff dashboard has KPI cards and quick actions only
        assert "pending tasks" in text
        assert drv.find_elements(By.CSS_SELECTOR, ".hosp-mini-donut-wrap svg")  # chart rendered
    else:
        for marker in ("pharmacy sales", "low stock", "prescriptions to dispense"):
            assert marker not in text, marker  # no pharmacy data without the Pharmacy module
    assert not error_toasts(drv), error_toasts(drv)
    assert not severe_console_errors(drv), severe_console_errors(drv)

    # Every quick action opens a page this login is allowed to see.
    labels = [b.text.split("\n")[1] if "\n" in b.text else b.text for b in drv.find_elements(By.CSS_SELECTOR, ".hosp-quick-btn")]
    assert labels, "no quick actions"
    for idx in range(len(labels)):
        drv.get(f"{config['base_url']}/dashboard")
        WebDriverWait(drv, 20).until(lambda d: len(d.find_elements(By.CSS_SELECTOR, ".hosp-quick-btn")) == len(labels))
        drv.find_elements(By.CSS_SELECTOR, ".hosp-quick-btn")[idx].click()
        WebDriverWait(drv, 10).until(lambda d: not d.current_url.endswith("/dashboard"))
        assert "access-denied" not in drv.current_url, labels[idx]
        assert not [t for t in error_toasts(drv) if "permission" in t.lower()], labels[idx]

    # The first KPI card navigates too.
    drv.get(f"{config['base_url']}/dashboard")
    WebDriverWait(drv, 20).until(lambda d: d.find_elements(By.CSS_SELECTOR, ".hosp-kpi-row .hosp-kpi-card"))
    drv.find_elements(By.CSS_SELECTOR, ".hosp-kpi-row .hosp-kpi-card")[0].click()
    WebDriverWait(drv, 10).until(lambda d: not d.current_url.endswith("/dashboard"))
    assert "access-denied" not in drv.current_url


def test_doctor_dashboards_are_isolated(login_as):
    a = login_as(username("doc_a"))
    WebDriverWait(a, 20).until(lambda d: f"Patient EA{TAG}" in dashboard_text(d))
    assert f"Patient EB{TAG}" not in dashboard_text(a)
    assert DR_A in dashboard_text(a)

    b = login_as(username("doc_b"))
    WebDriverWait(b, 20).until(lambda d: f"Patient EB{TAG}" in dashboard_text(d))
    assert f"Patient EA{TAG}" not in dashboard_text(b)


def test_date_filter_reloads_role_data(login_as, config):
    drv = login_as(username("reception"))
    WebDriverWait(drv, 20).until(lambda d: f"Patient EA{TAG}" in dashboard_text(d))
    # Same API the date picker calls, for a past day: the seeded appointments are not there.
    seen = drv.execute_async_script("""
        const done = arguments[arguments.length - 1];
        fetch('/api/dashboard/my?date=2020-01-01', {credentials: 'include'}).then(r => r.json()).then(done);
    """)
    assert seen["date"] == "2020-01-01"
    assert seen["persona"] == "receptionist"
    assert not any(f"EA{TAG}" in str(row) for row in seen["worklist"]["rows"])


def api_status(drv, path):
    """Status of a same-origin API call made with the logged-in browser session (a direct API call)."""
    return drv.execute_async_script("""
        const done = arguments[arguments.length - 1];
        fetch(arguments[0], {credentials: 'include'}).then(r => done(r.status)).catch(() => done(-1));
    """, path)


HOSPITAL_WIDE = ["/api/dashboard/hospital-summary", "/api/dashboard/summary", "/api/hospital/summary",
                 "/api/dashboard/analytics?days=14", "/api/dashboard/export/csv", "/api/dashboard/export/pdf"]


@pytest.mark.parametrize("key", ["nurse", "doc_a", "pharmacist", "billing_exec", "reception"])
def test_hospital_wide_endpoints_refuse_staff(login_as, key):
    drv = login_as(username(key))
    for path in HOSPITAL_WIDE:
        assert api_status(drv, path) == 403, path
    assert api_status(drv, "/api/dashboard/my") == 200


def test_hospital_wide_endpoints_allow_admins(login_as, config):
    for drv in (login_as(username("admin2")), login_as(config["user"], config["password"])):
        for path in HOSPITAL_WIDE:
            assert api_status(drv, path) == 200, path


def test_nurse_assignment_flow(login_as, seeded):
    nurse_name = "E2E Nurse"
    # Staff nurse: board is read-only and their patient list is empty until assigned.
    staff = login_as(username("nurse"))
    assert "no patients assigned to you" in dashboard_text(staff).lower()
    staff.get(staff.current_url.rsplit("/", 1)[0] + "/nurse-station")
    WebDriverWait(staff, 20).until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid=nurse-assignments-panel]")))
    assert not staff.find_elements(By.CSS_SELECTOR, "[data-testid=nurse-assign-form]")

    # Head nurse assigns the admitted patient through the UI.
    head = login_as(username("head_nurse"))
    head.get(head.current_url.rsplit("/", 1)[0] + "/nurse-station")
    form = WebDriverWait(head, 20).until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid=nurse-assign-form]")))
    from selenium.webdriver.support.ui import Select as UiSelect
    selects = form.find_elements(By.TAG_NAME, "select")
    UiSelect(selects[0]).select_by_value(str(seeded["ip_admission"]))
    UiSelect(selects[1]).select_by_value(username("nurse"))
    UiSelect(selects[2]).select_by_value("Morning")
    form.find_element(By.TAG_NAME, "button").click()
    WebDriverWait(head, 20).until(lambda d: nurse_name in d.find_element(By.CSS_SELECTOR, "[data-testid=nurse-assignments-table]").text)
    workload = head.find_element(By.CSS_SELECTOR, "[data-testid=nurse-workload-table]").text
    assert "nurse workload" in workload.lower() and nurse_name in workload

    # The assigned nurse now gets a personal dashboard and sees only their own workload row.
    mine = login_as(username("nurse"))
    WebDriverWait(mine, 20).until(lambda d: "my patients" in dashboard_text(d).lower())
    text = dashboard_text(mine).lower()
    assert "your 1 assigned patient" in text
    assert seeded["ip_patient"].lower() in text  # their upcoming dose
    mine.get(mine.current_url.rsplit("/", 1)[0] + "/nurse-station")
    table = WebDriverWait(mine, 20).until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid=nurse-workload-table]")))
    assert "my workload" in table.text.lower()
    assert "Head" not in table.text  # no other nurses' rows
    assert not error_toasts(mine)
