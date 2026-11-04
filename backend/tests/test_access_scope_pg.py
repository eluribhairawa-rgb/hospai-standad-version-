"""Employee-wise access isolation against a real PostgreSQL database.

Creates real employee accounts through the same signup code the Employee Management
screen uses (two doctors linked to doctor profiles, an admin and a nurse), real
patients and clinical records, and then checks what each login can see. It covers
the actual UNION query in access_scope.py against the live schema, the session
profile that carries the doctor link, and the route handlers.

Skipped unless TEST_DATABASE_URL is set, and refuses to run unless the database name
contains "test", so it can never touch the live hospital database.

    TEST_DATABASE_URL=postgresql://user:pass@host:5432/hospai_test \
        .venv/bin/python -m unittest tests.test_access_scope_pg -v
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
    from starlette.requests import Request

    import access_scope
    import database
    import legacy_queries as lq
    import schema_setup
    import security
    from models import Users
    from routers import clinical, patients as patients_api


def make_request(path, path_params=None, query=""):
    return Request({"type": "http", "method": "GET", "path": path, "path_params": path_params or {},
                    "query_string": query.encode(), "headers": [], "state": {}})


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class AccessIsolationPgTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema_setup.ensure_schema()
        cls.db = database.SessionLocal()
        db = cls.db
        tag = uuid.uuid4().hex[:6].upper()
        cls.hospital_id = security.resolve_hospital_id(db)
        cls.dr_a, cls.dr_b = f"Dr. Test Anil {tag}", f"Dr. Test Beena {tag}"

        # Real accounts via the Employee Management signup path.
        def signup(username, job_role, doctor_name="", user_type="normal"):
            res = security.signup_employee(db, {
                "username": f"{username}_{tag}".lower(), "password": "Passw0rd!x", "full_name": username,
                "job_role": job_role, "doctor_name": doctor_name, "user_type": user_type,
                "module_access": ["dashboard", "op-queue-management", "patients"],
            }, hospital_id=cls.hospital_id)
            assert res["success"], res
            user = db.query(Users).filter(Users.username == f"{username}_{tag}".lower()).one()
            # The profile the session layer builds on every request.
            return security.resolve_user_profile({
                "username": user.username, "role": user.role, "access_role": user.access_role,
                "user_type": user.user_type, "module_access": user.module_access, "full_name": user.full_name,
                "employee_id": user.employee_id, "status": user.status,
                "job_role": user.job_role, "doctor_name": user.doctor_name,
            }), user

        cls.doc_a, _ = signup("docanil", "Doctor", cls.dr_a)
        cls.doc_b, _ = signup("docbeena", "Doctor", cls.dr_b)
        cls.admin, _ = signup("chiefadmin", "Doctor", cls.dr_a, user_type="admin")
        cls.nurse, cls.nurse_row = signup("nursekavya", "Nurse", cls.dr_a)  # link must be dropped for non-doctors

        cls.pa_op, cls.pa_ip, cls.pb_op = f"TA{tag}1", f"TA{tag}2", f"TB{tag}1"
        for pid in (cls.pa_op, cls.pa_ip, cls.pb_op):
            db.execute(text("INSERT INTO patients (patient_id, name, last_name, hospital_id) VALUES (:p, 'Test', :p, :h)"),
                       {"p": pid, "h": cls.hospital_id})

        def appointment(pid, doctor, token):
            return db.execute(text(
                "INSERT INTO appointments (patient_id, patient_name, visit_type, appointment_date, token_no, status, doctor_name) "
                "VALUES (:p, 'Test', 'OP', CURRENT_TIMESTAMP, :t, 'scheduled', :d) RETURNING id"),
                {"p": pid, "d": doctor, "t": token}).scalar()

        cls.appt_a = appointment(cls.pa_op, cls.dr_a, 9001)
        cls.appt_b = appointment(cls.pb_op, cls.dr_b, 9002)
        # IP patient linked to Dr A only through the ER/IP encounter, with different case/spacing.
        db.execute(text("INSERT INTO encounters (patient_id, encounter_type, attending_doctor) VALUES (:p, 'IP', :d)"),
                   {"p": cls.pa_ip, "d": "  " + cls.dr_a.upper() + " "})
        cls.adm_a = db.execute(text("INSERT INTO admissions (patient_id, admission_date, hospital_id) VALUES (:p, CURRENT_TIMESTAMP, :h) RETURNING id"),
                               {"p": cls.pa_ip, "h": cls.hospital_id}).scalar()
        cls.adm_b = db.execute(text("INSERT INTO admissions (patient_id, admission_date, hospital_id) VALUES (:p, CURRENT_TIMESTAMP, :h) RETURNING id"),
                               {"p": cls.pb_op, "h": cls.hospital_id}).scalar()
        db.commit()

    @classmethod
    def tearDownClass(cls):
        cls.db.rollback()
        cls.db.close()

    def setUp(self):
        self.db.rollback()

    def scope(self, user):
        return access_scope.patient_scope(make_request("/api/x"), db=self.db, user=user)

    def blocked(self, user, path, path_params=None, query=""):
        with self.assertRaises(HTTPException) as ctx:
            access_scope.patient_access_guard(make_request(path, path_params, query), db=self.db, user=user)
        return ctx.exception.status_code == 404

    def allowed(self, user, path, path_params=None, query=""):
        access_scope.patient_access_guard(make_request(path, path_params, query), db=self.db, user=user)
        return True

    # ---------------------------------------------------------------- tests --

    def test_signup_links_doctor_profile_only_for_doctors(self):
        self.assertEqual(self.doc_a["doctor_name"], self.dr_a)
        self.assertIsNone(self.nurse_row.doctor_name)
        self.assertEqual(security.scoped_doctor_name(self.doc_a), self.dr_a)
        self.assertIsNone(security.scoped_doctor_name(self.admin))
        self.assertIsNone(security.scoped_doctor_name(self.nurse))

    def test_doctor_patient_sets_come_from_postgres_and_do_not_overlap(self):
        a, b = self.scope(self.doc_a), self.scope(self.doc_b)
        self.assertTrue({self.pa_op, self.pa_ip} <= a)
        self.assertIn(self.pb_op, b)
        self.assertNotIn(self.pb_op, a)
        self.assertFalse({self.pa_op, self.pa_ip} & b)
        self.assertIsNone(self.scope(self.admin))
        self.assertIsNone(self.scope(self.nurse))

    def test_direct_api_access_by_id(self):
        self.assertTrue(self.allowed(self.doc_a, f"/api/patients/{self.pa_ip}", {"patient_id": self.pa_ip}))
        self.assertTrue(self.blocked(self.doc_a, f"/api/patients/{self.pb_op}", {"patient_id": self.pb_op}))
        self.assertTrue(self.blocked(self.doc_b, f"/api/patients/{self.pa_op}", {"patient_id": self.pa_op}))
        self.assertTrue(self.allowed(self.doc_a, "/api/admissions/x/discharge-bill", {"admission_id": str(self.adm_a)}))
        self.assertTrue(self.blocked(self.doc_a, "/api/admissions/x/discharge-bill", {"admission_id": str(self.adm_b)}))
        self.assertTrue(self.blocked(self.doc_a, "/api/appointments/x", {"appointment_id": str(self.appt_b)}))
        for unrestricted in (self.admin, self.nurse):
            self.assertTrue(self.allowed(unrestricted, f"/api/patients/{self.pb_op}", {"patient_id": self.pb_op}))
            self.assertTrue(self.allowed(unrestricted, "/api/appointments/x", {"appointment_id": str(self.appt_b)}))

    def test_queue_shows_only_own_patients(self):
        def queue(user, doctor_filter=None):
            rows = clinical.appointments_list(date=None, status=None, visit_type=None, doctor_name=doctor_filter,
                                              patient_id=None, db=self.db, user=user)["appointments"]
            return {r["patient_id"] for r in rows}

        self.assertIn(self.pa_op, queue(self.doc_a))
        self.assertNotIn(self.pb_op, queue(self.doc_a))
        self.assertNotIn(self.pb_op, queue(self.doc_a, doctor_filter=self.dr_b))  # filter tampering
        self.assertNotIn(self.pa_op, queue(self.doc_b))
        self.assertTrue({self.pa_op, self.pb_op} <= queue(self.admin))
        self.assertTrue({self.pa_op, self.pb_op} <= queue(self.nurse))

    def test_patient_registry_is_filtered(self):
        def registry(user):
            out = patients_api.patients_list(q=None, visit_status=None, db=self.db, user=user,
                                             hospital_id=self.hospital_id, scope=self.scope(user))
            return {p["patient_id"] for p in out["patients"]}

        a = registry(self.doc_a)
        self.assertTrue({self.pa_op, self.pa_ip} <= a)
        self.assertNotIn(self.pb_op, a)
        self.assertNotIn(self.pa_op, registry(self.doc_b))
        self.assertTrue({self.pa_op, self.pa_ip, self.pb_op} <= registry(self.admin))

    def test_doctor_cannot_prescribe_for_other_doctors_patient(self):
        with self.assertRaises(HTTPException):
            clinical.prescriptions_create(payload={"patient_id": self.pb_op, "medicines": []}, db=self.db,
                                          user=self.doc_a, scope=self.scope(self.doc_a))

    def test_employee_edit_keeps_or_drops_link(self):
        emp_id = self.db.execute(text("SELECT employee_id FROM users WHERE username = :u"),
                                 {"u": self.doc_b["username"]}).scalar()
        lq.update_employee(self.db, emp_id, {"user_type": "normal"}, hospital_id=self.hospital_id)  # partial update
        self.assertEqual(lq.get_employee(self.db, employee_id=emp_id, hospital_id=self.hospital_id)["doctor_name"], self.dr_b)
        lq.update_employee(self.db, emp_id, {"job_role": "Nurse", "doctor_name": self.dr_b}, hospital_id=self.hospital_id)
        self.assertIsNone(lq.get_employee(self.db, employee_id=emp_id, hospital_id=self.hospital_id)["doctor_name"])


if __name__ == "__main__":
    unittest.main()
