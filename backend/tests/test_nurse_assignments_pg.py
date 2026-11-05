"""Nurse-to-IPD-patient assignment, per-nurse workload and the nurse dashboard on real PostgreSQL.

Skipped unless TEST_DATABASE_URL is set; refuses to run unless the database name contains "test".

    TEST_DATABASE_URL=postgresql://user:pass@host:5432/hospai_test \
        .venv/bin/python -m unittest tests.test_nurse_assignments_pg -v
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

    import database
    import schema_setup
    import security
    from deps import require_hospital_overview
    from models import Users
    from routers import clinical, nursing


def make_request():
    return Request({"type": "http", "method": "POST", "path": "/api/nursing/assignments", "path_params": {},
                    "query_string": b"", "headers": [], "state": {}, "client": ("127.0.0.1", 1)})


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class NurseAssignmentPgTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema_setup.ensure_schema()
        cls.db = database.SessionLocal()
        db = cls.db
        tag = uuid.uuid4().hex[:6].upper()
        cls.hospital_id = security.resolve_hospital_id(db)

        def signup(username, job_role, modules, user_type="normal"):
            uname = f"{username}_{tag}".lower()
            res = security.signup_employee(db, {
                "username": uname, "password": "Passw0rd!x", "full_name": f"{username} {tag}",
                "job_role": job_role, "user_type": user_type, "module_access": modules,
            }, hospital_id=cls.hospital_id)
            assert res["success"], res
            u = db.query(Users).filter(Users.username == uname).one()
            profile = security.resolve_user_profile({
                "username": u.username, "role": u.role, "access_role": u.access_role, "user_type": u.user_type,
                "module_access": u.module_access, "full_name": u.full_name, "employee_id": u.employee_id,
                "status": u.status, "job_role": u.job_role, "doctor_name": u.doctor_name,
            })
            profile["hospital_id"] = cls.hospital_id
            return profile

        ipd = ["dashboard", "patients", "ip-management"]
        cls.head = signup("headnurse", "Head Nurse", ipd)
        cls.nurse1 = signup("nurseone", "Nurse", ipd)
        cls.nurse2 = signup("nursetwo", "Staff Nurse", ipd)
        cls.reception = signup("recept", "Receptionist", ["dashboard", "patients", "patient-registration"])
        cls.reporter = signup("reporter", "Accountant", ["dashboard", "reports"])
        cls.admin = signup("nadmin", "Admin", ipd, user_type="admin")

        cls.adm = {}
        for i, bed in enumerate(("N1", "N2", "N3")):
            pid = f"NP{tag}{i}"
            db.execute(text("INSERT INTO patients (patient_id, name, last_name, hospital_id) VALUES (:p, 'Ward', :p, :h)"),
                       {"p": pid, "h": cls.hospital_id})
            adm = db.execute(text("INSERT INTO admissions (patient_id, admission_date, hospital_id) "
                                  "VALUES (:p, CURRENT_TIMESTAMP, :h) RETURNING id"), {"p": pid, "h": cls.hospital_id}).scalar()
            db.execute(text("INSERT INTO bed_allocations (admission_id, patient_id, ward, bed_no, status) "
                            "VALUES (:a, :p, :w, :b, 'active')"), {"a": adm, "p": pid, "w": f"Ward {tag}", "b": bed})
            cls.adm[i] = (adm, pid)
        # Two pending doses today for patient 0 (one overdue), one for patient 1.
        def dose(i, minutes):
            adm, pid = cls.adm[i]
            db.execute(text("INSERT INTO emar_records (patient_id, admission_id, medicine_name, scheduled_time, status) "
                            "VALUES (:p, :a, 'Paracetamol', (NOW() AT TIME ZONE 'Asia/Kolkata') + (:m || ' minutes')::interval, 'pending')"),
                       {"p": pid, "a": adm, "m": str(minutes)})
        dose(0, -120)
        dose(0, 20)
        dose(1, 30)
        db.commit()

    @classmethod
    def tearDownClass(cls):
        cls.db.rollback()
        cls.db.close()

    def setUp(self):
        self.db.rollback()

    def assign(self, actor, i, nurse, shift=None):
        return nursing.assignments_create(make_request(), {"admission_id": self.adm[i][0], "nurse_username": nurse["username"],
                                                           "shift": shift}, db=self.db, user=actor, hospital_id=self.hospital_id)

    def board(self, user):
        return nursing.assignments_list(mine=False, db=self.db, user=user, hospital_id=self.hospital_id, scope=None)

    def test_01_supervisor_assigns_and_nurse_dashboard_becomes_personal(self):
        before = clinical.dashboard_my(date=None, db=self.db, user=self.nurse1, hospital_id=self.hospital_id)
        self.assertEqual(before["scope_label"], "No patients assigned to you")
        self.assertTrue(before["notice"])

        self.assign(self.head, 0, self.nurse1)
        self.assign(self.admin, 1, self.nurse2, shift="Night")

        out = clinical.dashboard_my(date=None, db=self.db, user=self.nurse1, hospital_id=self.hospital_id)
        kpis = {k["key"]: k["value"] for k in out["kpis"]}
        self.assertEqual(out["persona"], "nurse")
        self.assertIsNone(out["notice"])
        self.assertEqual(kpis["my_patients"], 1)
        self.assertEqual(kpis["doses_due"], 2)          # only patient 0's doses
        self.assertEqual(kpis["overdue"], 1)
        self.assertTrue(all(row[1] == self.adm[0][1] for row in out["worklist"]["rows"]))

        n2 = clinical.dashboard_my(date=None, db=self.db, user=self.nurse2, hospital_id=self.hospital_id)
        self.assertEqual({k["key"]: k["value"] for k in n2["kpis"]}["doses_due"], 1)

    def test_02_handover_ends_previous_assignment(self):
        self.assign(self.head, 2, self.nurse1)
        self.assign(self.head, 2, self.nurse2)  # same admission, same (any) shift -> hand-over
        rows = [a for a in self.board(self.head)["assignments"] if a["admission_id"] == self.adm[2][0]]
        self.assertEqual([a["assigned_nurse"] for a in rows], [self.nurse2["username"]])

    def test_03_workload_scope(self):
        all_rows = nursing.workload(date=None, db=self.db, user=self.head, hospital_id=self.hospital_id)
        self.assertEqual(all_rows["scope"], "all")
        by = {w["username"]: w for w in all_rows["workload"]}
        self.assertEqual(by[self.nurse1["username"]]["overdue"], 1)
        own = nursing.workload(date=None, db=self.db, user=self.nurse1, hospital_id=self.hospital_id)
        self.assertEqual(own["scope"], "self")
        self.assertEqual([w["username"] for w in own["workload"]], [self.nurse1["username"]])

    def test_04_staff_nurse_and_other_roles_cannot_assign(self):
        for actor in (self.nurse1, self.reception):
            with self.assertRaises(HTTPException) as ctx:
                nursing.require_ipd_manage(actor)
            self.assertEqual(ctx.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            nursing.require_ipd_view(self.reception)  # no Inpatient module
        self.assertFalse(self.board(self.nurse1)["can_manage"])
        self.assertEqual(self.board(self.nurse1)["nurses"], [])

    def test_05_only_nurses_and_admitted_patients(self):
        with self.assertRaises(HTTPException) as ctx:
            self.assign(self.head, 0, self.reception)
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            nursing.assignments_create(make_request(), {"admission_id": 999999999, "nurse_username": self.nurse1["username"]},
                                       db=self.db, user=self.head, hospital_id=self.hospital_id)
        with self.assertRaises(HTTPException):
            self.assign(self.head, 0, self.nurse1, shift="Lunch")

    def test_06_end_assignment(self):
        res = self.assign(self.head, 1, self.nurse1, shift="Morning")
        nursing.assignments_end(res["assignment"]["id"], make_request(), db=self.db, user=self.head, hospital_id=self.hospital_id)
        ids = {a["id"] for a in self.board(self.head)["assignments"]}
        self.assertNotIn(res["assignment"]["id"], ids)
        with self.assertRaises(HTTPException):
            nursing.assignments_end(res["assignment"]["id"], make_request(), db=self.db, user=self.head, hospital_id=self.hospital_id)

    def test_07_hospital_wide_endpoints_refuse_non_admin_staff(self):
        guard = require_hospital_overview("patients.read")
        for user in (self.nurse1, self.head, self.reception):
            with self.assertRaises(HTTPException) as ctx:
                guard(user)
            self.assertEqual(ctx.exception.status_code, 403)
        for user in (self.admin, self.reporter):
            self.assertIs(guard(user), user)
        summary = clinical.dashboard_hospital_summary(date=None, db=self.db, user=guard(self.admin))
        self.assertIn("revenue", summary)


if __name__ == "__main__":
    unittest.main()
