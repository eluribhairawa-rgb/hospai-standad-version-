"""Employee-wise access isolation (no database needed).

Several employee accounts -- two doctors, an admin who is also a doctor, a nurse and a
doctor login that has not been linked yet -- hit the same patients, records and list
endpoints. The guard and the route handlers are called directly (the same code
FastAPI runs per request); the database is a small in-memory fake that answers the
handful of SQL lookups access_scope.py makes.

Run from backend/:  .venv/bin/python -m unittest discover -s tests -v
"""
import os
import sys
import unittest
from unittest import mock

os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/unit_tests")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402

import access_scope  # noqa: E402
import security  # noqa: E402
from routers import clinical, diagnostics, employees_bed, patients  # noqa: E402

ALL_PERMS = ["patients.read", "patients.write", "diag.read", "pharmacy.read", "billing.read", "lab.read", "ot.read"]


def employee(username, job_role, doctor_name=None, user_type="normal"):
    return {"username": username, "user_type": user_type, "job_role": job_role,
            "doctor_name": doctor_name, "permissions": ALL_PERMS}


DOC_A = employee("dr_anil", "Doctor", "Dr. Anil Rao")
DOC_B = employee("dr_beena", "Doctor", "Dr. Beena Shah")
ADMIN_DOC = employee("chief", "Doctor", "Dr. Anil Rao", user_type="admin")
NURSE = employee("nurse_kavya", "Nurse")
UNLINKED_DOC = employee("dr_new", "Doctor", None)

# patient -> doctor responsible (via appointments / admissions / diag orders)
PATIENTS = {"P-A1": "dr. anil rao", "P-A2": "dr. anil rao", "P-B1": "dr. beena shah"}
APPOINTMENTS = {101: ("P-A1", "Dr. Anil Rao"), 201: ("P-B1", "Dr. Beena Shah")}
ADMISSIONS = {11: "P-A2", 21: "P-B1"}
DIAG_ORDERS = {501: "P-A1", 601: "P-B1", 701: None}  # 701 = walk-in, no patient


class _Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeDB:
    """Answers only the SQL that access_scope / the scoped routes issue."""

    def __init__(self):
        self.statements = []

    def execute(self, sql, params=None):
        q = " ".join(str(sql).split())
        params = params or {}
        self.statements.append(q)
        if "UNION SELECT" in q:
            return _Result([(p,) for p, d in PATIENTS.items() if d == params["d"]])
        if q.startswith("SELECT doctor_name FROM appointments WHERE id"):
            appt = APPOINTMENTS.get(params["v"])
            return _Result([(appt[1],)] if appt else [])
        if q.startswith("SELECT patient_id FROM admissions WHERE id"):
            return _Result([(ADMISSIONS[params["v"]],)] if params["v"] in ADMISSIONS else [])
        if q.startswith("SELECT patient_id FROM diag_orders WHERE id"):
            return _Result([(DIAG_ORDERS[params["v"]],)] if params["v"] in DIAG_ORDERS else [])
        return _Result([])


def make_request(path, path_params=None, query=""):
    scope = {"type": "http", "method": "GET", "path": path, "path_params": path_params or {},
             "query_string": query.encode(), "headers": [], "state": {}}
    return Request(scope)


class AccessScopeTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()

    # -------------------------------------------------------------- helpers --

    def guard(self, user, path, path_params=None, query=""):
        access_scope.patient_access_guard(make_request(path, path_params, query), db=self.db, user=user)

    def assert_blocked(self, user, path, path_params=None, query=""):
        with self.assertRaises(HTTPException) as ctx:
            self.guard(user, path, path_params, query)
        self.assertEqual(ctx.exception.status_code, 404)

    def scope_for(self, user):
        return access_scope.patient_scope(make_request("/api/x"), db=self.db, user=user)

    # ------------------------------------------------------ who is scoped --

    def test_only_linked_non_admin_doctors_are_scoped(self):
        self.assertEqual(security.scoped_doctor_name(DOC_A), "Dr. Anil Rao")
        self.assertIsNone(security.scoped_doctor_name(ADMIN_DOC))
        self.assertIsNone(security.scoped_doctor_name(NURSE))
        self.assertIsNone(security.scoped_doctor_name(UNLINKED_DOC))
        self.assertIsNone(security.scoped_doctor_name({**NURSE, "doctor_name": "Dr. Anil Rao"}))

    def test_patient_sets_are_disjoint_per_doctor(self):
        self.assertEqual(self.scope_for(DOC_A), {"P-A1", "P-A2"})
        self.assertEqual(self.scope_for(DOC_B), {"P-B1"})
        for unrestricted in (ADMIN_DOC, NURSE, UNLINKED_DOC):
            self.assertIsNone(self.scope_for(unrestricted))

    def test_patient_set_is_queried_once_per_request(self):
        req = make_request("/api/patients/P-A1", {"patient_id": "P-A1"})
        access_scope.patient_access_guard(req, db=self.db, user=DOC_A)
        access_scope.patient_scope(req, db=self.db, user=DOC_A)
        self.assertEqual(sum("UNION SELECT" in s for s in self.db.statements), 1)

    # ---------------------------------------------- direct API calls by id --

    def test_patient_id_in_path_or_query(self):
        self.guard(DOC_A, "/api/patients/P-A1", {"patient_id": "P-A1"})
        self.assert_blocked(DOC_A, "/api/patients/P-B1", {"patient_id": "P-B1"})
        self.assert_blocked(DOC_B, "/api/patients/P-A2/emar", {"patient_id": "P-A2"})
        self.assert_blocked(DOC_A, "/api/prescriptions", query="patient_id=P-B1")
        self.assert_blocked(DOC_A, "/api/patients/UNKNOWN", {"patient_id": "UNKNOWN"})
        for unrestricted in (ADMIN_DOC, NURSE, UNLINKED_DOC):
            self.guard(unrestricted, "/api/patients/P-B1", {"patient_id": "P-B1"})

    def test_admission_ids_resolve_to_their_patient(self):
        self.guard(DOC_A, "/api/admissions/11/discharge-bill", {"admission_id": "11"})
        self.assert_blocked(DOC_A, "/api/admissions/21/discharge-bill", {"admission_id": "21"})
        self.assert_blocked(DOC_A, "/api/pharmacy/sales", query="admission_id=21")
        self.assert_blocked(DOC_A, "/api/admissions/21/summary-data", {"identifier": "21"})
        self.assert_blocked(DOC_A, "/api/admissions/P-B1/summary-data", {"identifier": "P-B1"})
        self.guard(DOC_B, "/api/admissions/21/discharge-bill", {"admission_id": "21"})

    def test_diag_orders_only_resolved_under_diag_api(self):
        self.guard(DOC_A, "/api/diag/orders/501", {"order_id": "501"})
        self.assert_blocked(DOC_A, "/api/diag/orders/601", {"order_id": "601"})
        self.assert_blocked(DOC_A, "/api/diag/orders/701", {"order_id": "701"})  # walk-in, no patient
        # Same parameter name elsewhere is not a diag order and must not be looked up there.
        self.guard(DOC_A, "/api/pharmacy/purchase-orders/601", {"order_id": "601"})

    def test_missing_record_is_left_to_the_route(self):
        self.guard(DOC_A, "/api/diag/orders/999", {"order_id": "999"})
        self.guard(DOC_A, "/api/diag/orders/abc", {"order_id": "abc"})

    def test_other_doctors_appointment_cannot_be_touched(self):
        self.guard(DOC_A, "/api/appointments/101", {"appointment_id": "101"})
        with self.assertRaises(HTTPException) as ctx:
            self.guard(DOC_A, "/api/appointments/201", {"appointment_id": "201"})
        self.assertEqual(ctx.exception.status_code, 404)
        self.guard(ADMIN_DOC, "/api/appointments/201", {"appointment_id": "201"})

    # --------------------------------------------------------- list views --

    def test_patient_list_is_filtered(self):
        rows = [{"patient_id": p} for p in ("P-A1", "P-A2", "P-B1", "P-X")]
        with mock.patch.object(patients.lq, "get_all_patients", return_value=rows):
            for user, expected in ((DOC_A, ["P-A1", "P-A2"]), (DOC_B, ["P-B1"]), (NURSE, ["P-A1", "P-A2", "P-B1", "P-X"])):
                out = patients.patients_list(q=None, visit_status=None, db=self.db, user=user, hospital_id=1,
                                             scope=self.scope_for(user))
                self.assertEqual([p["patient_id"] for p in out["patients"]], expected, user["username"])

    def test_queue_is_forced_to_own_doctor(self):
        with mock.patch.object(clinical.lq, "list_appointments", return_value=[]) as la:
            clinical.appointments_list(date=None, status=None, visit_type=None, doctor_name="Dr. Beena Shah",
                                       patient_id=None, db=self.db, user=DOC_A)
            self.assertEqual(la.call_args.kwargs["doctor_name"], "Dr. Anil Rao")
            clinical.appointments_list(date=None, status=None, visit_type=None, doctor_name="Dr. Beena Shah",
                                       patient_id=None, db=self.db, user=ADMIN_DOC)
            self.assertEqual(la.call_args.kwargs["doctor_name"], "Dr. Beena Shah")
            clinical.appointments_list(date=None, status=None, visit_type=None, doctor_name=None,
                                       patient_id=None, db=self.db, user=NURSE)
            self.assertIsNone(la.call_args.kwargs["doctor_name"])

    def test_doctors_history_is_forced_to_own_doctor(self):
        with mock.patch.object(clinical.lq, "list_doctors_history", return_value=[]) as h:
            clinical.doctors_history_list(doctor_name="All", from_date=None, to_date=None, department=None,
                                          db=self.db, user=DOC_B, hospital_id=1)
            self.assertEqual(h.call_args.kwargs["doctor_name"], "Dr. Beena Shah")

    def test_encounters_and_diag_lists_are_filtered(self):
        rows = [{"patient_id": "P-A1"}, {"patient_id": "P-B1"}]
        with mock.patch.object(employees_bed.lq, "list_encounters", return_value=rows):
            out = employees_bed.encounters_list(encounter_type=None, active_only=False, db=self.db, user=DOC_B,
                                                scope=self.scope_for(DOC_B))
        self.assertEqual([e["patient_id"] for e in out["encounters"]], ["P-B1"])
        with mock.patch.object(diagnostics.lq, "list_diag_orders", return_value=rows + [{"patient_id": None}]):
            out = diagnostics.diag_orders_list(db=self.db, user=DOC_A, scope=self.scope_for(DOC_A))
        self.assertEqual([o["patient_id"] for o in out["orders"]], ["P-A1"])

    # ---------------------------------------------------------- writes --

    def test_doctor_cannot_prescribe_for_another_doctors_patient(self):
        with self.assertRaises(HTTPException) as ctx:
            clinical.prescriptions_create(payload={"patient_id": "P-B1", "medicines": []}, db=self.db, user=DOC_A,
                                          scope=self.scope_for(DOC_A))
        self.assertEqual(ctx.exception.status_code, 404)

    def test_doctor_cannot_prescribe_on_another_doctors_appointment(self):
        with self.assertRaises(HTTPException) as ctx:
            clinical.prescriptions_create(payload={"patient_id": "P-A1", "appointment_id": 201, "medicines": []},
                                          db=self.db, user=DOC_A, scope=self.scope_for(DOC_A))
        self.assertEqual(ctx.exception.detail, "Appointment not found")

    def test_doctor_booking_always_lands_in_own_queue(self):
        payload = {"patient_name": "X", "visit_type": "OP", "appointment_date": "2999-01-01",
                   "consultation_fee": 0, "doctor_name": "Dr. Beena Shah"}
        with mock.patch.object(clinical.lq, "create_op_appointment_with_invoice", return_value=(1, "T1", 1, 1)) as create, \
             mock.patch.object(clinical.lq, "list_doctor_schedules", return_value=[{"consultation_fee": 500, "review_fee": 300}]), \
             mock.patch.object(clinical, "log_audit_event"):
            clinical.appointments_create(request=make_request("/api/appointments"), payload=payload, db=self.db, user=DOC_A)
        self.assertEqual(create.call_args.args[1]["doctor_name"], "Dr. Anil Rao")

    def test_doctor_cannot_reassign_appointment(self):
        with mock.patch.object(clinical.lq, "update_appointment", return_value=True) as upd, \
             mock.patch.object(clinical, "log_audit_event"):
            clinical.appointments_update(101, request=make_request("/api/appointments/101"),
                                         payload={"doctor_name": "Dr. Beena Shah", "status": "Completed"},
                                         db=self.db, user=DOC_A)
        self.assertEqual(upd.call_args.args[2]["doctor_name"], "Dr. Anil Rao")

    # ------------------------------------------------- employee profile link --

    def test_doctor_link_kept_only_for_doctor_job_title(self):
        self.assertEqual(security.linked_doctor_name("Doctor", "  Dr. Anil Rao "), "Dr. Anil Rao")
        self.assertEqual(security.linked_doctor_name("doctor", "Dr. Anil Rao"), "Dr. Anil Rao")
        self.assertIsNone(security.linked_doctor_name("Nurse", "Dr. Anil Rao"))
        self.assertIsNone(security.linked_doctor_name("Doctor", "   "))


class RouterWiringTests(unittest.TestCase):
    def test_guard_is_attached_to_every_data_router(self):
        import main
        guarded, unguarded = set(), set()
        for route in main.app.router.routes:
            # FastAPI >= 0.140 keeps included routers nested; older versions flatten them into APIRoutes.
            contexts = getattr(route, "effective_route_contexts", None)
            subs = list(contexts() if callable(contexts) else contexts) if contexts is not None else [route]
            for sub in subs:
                path = getattr(sub, "path", "")
                if not path.startswith("/api/"):
                    continue
                deps = [d.call for d in getattr(getattr(sub, "dependant", None), "dependencies", [])]
                (guarded if access_scope.patient_access_guard in deps else unguarded).add(path)
        self.assertIn("/api/patients/{patient_id}", guarded)
        self.assertIn("/api/appointments/{appointment_id}", guarded)
        self.assertIn("/api/diag/orders/{order_id}", guarded)
        self.assertIn("/api/patients/{patient_id}/emar", guarded)
        leaking = sorted(p for p in unguarded if "patient" in p or "admission" in p)
        self.assertEqual(leaking, [], "patient routes without the access guard")


if __name__ == "__main__":
    unittest.main()
