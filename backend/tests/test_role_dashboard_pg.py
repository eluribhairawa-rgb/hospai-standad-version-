"""Role-based dashboards against a real PostgreSQL database.

Creates real employee accounts (two linked doctors, a nurse, a receptionist, a
pharmacist, a lab technician, billing staff, an admin and a super admin) through
the Employee Management signup path, adds clinical records for each doctor, and
calls GET /api/dashboard/my as each login. Checks that every role's queries run
against the live schema, that each login gets its own persona and widgets, that a
doctor only sees their own patients, and that the admin dashboard APIs are
unchanged.

Skipped unless TEST_DATABASE_URL is set; refuses to run unless the database name
contains "test".

    TEST_DATABASE_URL=postgresql://user:pass@host:5432/hospai_test \
        .venv/bin/python -m unittest tests.test_role_dashboard_pg -v
"""
import os
import sys
import unittest
import uuid

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
if TEST_DATABASE_URL:
    os.environ["DATABASE_URL"] = TEST_DATABASE_URL
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _test_db_guard():
    if not TEST_DATABASE_URL:
        return "TEST_DATABASE_URL is not set"
    import database
    name = database.engine.url.database or ""
    if "test" not in name.lower():
        return f"refusing to run against database '{name}' (name must contain 'test')"
    return None


SKIP_REASON = _test_db_guard()

if not SKIP_REASON:
    from fastapi import HTTPException
    from sqlalchemy import text

    import database
    import schema_setup
    import security
    from deps import require_permissions
    from models import Users
    from routers import clinical


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class RoleDashboardPgTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema_setup.ensure_schema()
        cls.db = database.SessionLocal()
        db = cls.db
        tag = uuid.uuid4().hex[:6].upper()
        cls.tag = tag
        cls.hospital_id = security.resolve_hospital_id(db)
        cls.dr_a, cls.dr_b = f"Dr. Dash Anil {tag}", f"Dr. Dash Beena {tag}"

        def signup(username, job_role, modules, doctor_name="", user_type="normal"):
            uname = f"{username}_{tag}".lower()
            res = security.signup_employee(db, {
                "username": uname, "password": "Passw0rd!x", "full_name": username,
                "job_role": job_role, "doctor_name": doctor_name, "user_type": user_type,
                "module_access": modules,
            }, hospital_id=cls.hospital_id)
            assert res["success"], res
            u = db.query(Users).filter(Users.username == uname).one()
            return security.resolve_user_profile({
                "username": u.username, "role": u.role, "access_role": u.access_role,
                "user_type": u.user_type, "module_access": u.module_access, "full_name": u.full_name,
                "employee_id": u.employee_id, "status": u.status,
                "job_role": u.job_role, "doctor_name": u.doctor_name,
            })

        base = ["dashboard", "patients", "queue-management"]
        cls.users = {
            "doc_a": signup("dashanil", "Doctor", base + ["doctor-prescription", "ip-management"], cls.dr_a),
            "doc_b": signup("dashbeena", "Doctor", base, cls.dr_b),
            "doc_unlinked": signup("dashnew", "Doctor", base),
            "nurse": signup("dashnurse", "Nurse", base + ["ip-management", "bed-management"]),
            "reception": signup("dashrecept", "Receptionist", base + ["patient-registration", "follow-up"]),
            "pharmacist": signup("dashpharm", "Technician", ["dashboard", "pharmacy"]),
            "lab": signup("dashlab", "Technician", ["dashboard", "lab-diagnostics"]),
            "billing": signup("dashbill", "Other", ["dashboard", "billing"]),
            "admin": signup("dashadmin", "Admin", base, user_type="admin"),
            "super": signup("dashsuper", "Admin", base, user_type="super_admin"),
        }

        cls.today = db.execute(text("SELECT CURRENT_DATE")).scalar().isoformat()
        cls.pa, cls.pb = f"DA{tag}1", f"DB{tag}1"
        for pid in (cls.pa, cls.pb):
            db.execute(text("INSERT INTO patients (patient_id, name, last_name, hospital_id) VALUES (:p, 'Dash', :p, :h)"),
                       {"p": pid, "h": cls.hospital_id})

        def appt(pid, doctor, token, status):
            db.execute(text(
                "INSERT INTO appointments (patient_id, patient_name, visit_type, appointment_date, token_no, status, doctor_name) "
                "VALUES (:p, :n, 'OP', CAST(:day AS date) + TIME '10:00', :t, :s, :d)"),
                {"p": pid, "n": f"Dash {pid}", "d": doctor, "t": token, "s": status, "day": cls.today})

        # Dr A: 2 waiting + 1 completed. Dr B: 3 waiting.
        appt(cls.pa, cls.dr_a, 9101, "scheduled")
        appt(cls.pa, cls.dr_a, 9102, "checked_in")
        appt(cls.pa, cls.dr_a, 9103, "completed")
        for t in (9201, 9202, 9203):
            appt(cls.pb, cls.dr_b, t, "waiting")
        db.commit()

    @classmethod
    def tearDownClass(cls):
        cls.db.rollback()
        cls.db.close()

    def setUp(self):
        self.db.rollback()

    def dash(self, key):
        user = require_permissions("patients.read")(self.users[key])  # same dependency the route declares
        return clinical.dashboard_my(date=self.today, db=self.db, user=user, hospital_id=self.hospital_id)

    def kpi(self, out, key):
        return next(k for k in out["kpis"] if k["key"] == key)["value"]

    # ---------------------------------------------------------------- tests --

    def test_every_role_builds_against_live_schema(self):
        expected = {
            "doc_a": "doctor", "nurse": "nurse", "reception": "receptionist", "pharmacist": "pharmacist",
            "lab": "lab_technician", "billing": "billing",
        }
        for key, persona in expected.items():
            with self.subTest(role=key):
                out = self.dash(key)
                self.assertEqual(out["persona"], persona)
                self.assertGreaterEqual(len(out["kpis"]), 3)
                self.assertTrue(out["breakdown"]["items"])
                self.assertIn("rows", out["worklist"])

    def test_doctor_sees_only_own_queue(self):
        a, b = self.dash("doc_a"), self.dash("doc_b")
        self.assertEqual(self.kpi(a, "appointments"), 3)
        self.assertEqual(self.kpi(a, "waiting"), 2)
        self.assertEqual(self.kpi(b, "appointments"), 3)
        self.assertEqual(self.kpi(b, "waiting"), 3)
        a_patients = {row[1] for row in a["worklist"]["rows"]}
        self.assertIn(f"Dash {self.pa}", a_patients)
        self.assertNotIn(f"Dash {self.pb}", a_patients)

    def test_unlinked_doctor_gets_notice_not_hospital_data(self):
        out = self.dash("doc_unlinked")
        self.assertEqual(out["persona"], "doctor")
        self.assertEqual(out["kpis"], [])
        self.assertTrue(out["notice"])

    def test_receptionist_sees_all_doctors_appointments(self):
        out = self.dash("reception")
        self.assertGreaterEqual(self.kpi(out, "appointments"), 6)

    def test_admin_and_super_admin_unaffected(self):
        for key in ("admin", "super"):
            with self.subTest(role=key):
                self.assertEqual(self.dash(key)["persona"], "admin")
                # Existing executive dashboard APIs still answer as before.
                summary = clinical.dashboard_hospital_summary(date=self.today, db=self.db, user=self.users[key])
                self.assertIn("revenue", summary)
                stats = clinical.stats(date=self.today, db=self.db, user=self.users[key], hospital_id=self.hospital_id)
                self.assertIn("today", stats)

    def test_logins_without_dashboard_permission_are_refused(self):
        no_dash = dict(self.users["pharmacist"], permissions=["pharmacy.read"])
        with self.assertRaises(HTTPException) as ctx:
            require_permissions("patients.read")(no_dash)
        self.assertEqual(ctx.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
