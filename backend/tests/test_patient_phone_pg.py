"""Patient phone country codes and partial updates, against a real PostgreSQL database.

Skipped unless TEST_DATABASE_URL is set, and refuses to run unless the database name
contains "test", so it can never touch the live hospital database.

    TEST_DATABASE_URL=postgresql://user:pass@host:5432/hospai_test \
        .venv/bin/python -m unittest tests.test_patient_phone_pg -v
"""
import os
import sys
import unittest
import uuid
from types import SimpleNamespace

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

    import database
    import legacy_queries as lq
    import schema_setup
    from routers import patients as api
    from security import resolve_hospital_id

REQ = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
USER = {"username": "test_reception"}


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class PatientPhoneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema_setup.ensure_schema()
        cls.db = database.SessionLocal()
        cls.hospital_id = resolve_hospital_id(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def setUp(self):
        self.db.rollback()
        self.tag = uuid.uuid4().hex[:6]

    def create(self, **extra):
        payload = {"name": f"Ph{self.tag}", "last_name": "Test", "gender": "Female", "age": 30,
                   "address": "12 MG Road", "phone": "9876543210", **extra}
        return api.patients_create(request=REQ, payload=payload, db=self.db, user=USER, hospital_id=self.hospital_id)

    def stored(self, patient_id):
        return lq.get_patient(self.db, patient_id, hospital_id=self.hospital_id)

    def test_uae_number_is_stored_with_its_country_code(self):
        out = self.create(phone="501234567", phone_country_code="+971")
        p = self.stored(out["patient_id"] if isinstance(out, dict) else out)
        self.assertEqual((p["phone"], p["phone_country_code"]), ("501234567", "+971"))

    def test_wrong_length_for_country_is_rejected(self):
        for phone, code in (("939145189787654", "+91"), ("9876543210", "+971"), ("98765432", "+91")):
            with self.subTest(phone=phone, code=code), self.assertRaises(HTTPException) as ctx:
                self.create(phone=phone, phone_country_code=code)
            self.assertEqual(ctx.exception.status_code, 400)
            self.db.rollback()

    def test_partial_edit_keeps_fields_it_did_not_send(self):
        out = self.create(phone="9876543210", emergency_contact="Ravi", emergency_relation="Brother",
                          emergency_mobile="9123456780", family_mobile="9012345678", email="a@example.com",
                          nationality="Indian", marital_status="Single")
        pid = out["patient_id"] if isinstance(out, dict) else out
        # The Patients page edit form sends only these fields.
        api.patients_update(pid, request=REQ, db=self.db, user=USER, hospital_id=self.hospital_id, payload={
            "name": f"Ph{self.tag}", "middle_name": "", "last_name": "Test", "dob": None, "age": 31, "gender": "Female",
            "pregnant": False, "allergies": "", "symptoms": "", "phone": "501234567", "phone_country_code": "+971",
            "address": "14 MG Road",
        })
        p = self.stored(pid)
        self.assertEqual((p["phone"], p["phone_country_code"], p["address"], p["age"]), ("501234567", "+971", "14 MG Road", 31))
        self.assertEqual(
            (p["emergency_contact"], p["emergency_relation"], p["emergency_mobile"], p["family_mobile"], p["email"], p["nationality"], p["marital_status"]),
            ("Ravi", "Brother", "9123456780", "9012345678", "a@example.com", "Indian", "Single"),
        )



@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class OtherPhoneFieldsTests(unittest.TestCase):
    """Suppliers, insurance providers, lab walk-ins and staff phones store their country code."""

    @classmethod
    def setUpClass(cls):
        schema_setup.ensure_schema()
        cls.db = database.SessionLocal()
        cls.hospital_id = resolve_hospital_id(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def setUp(self):
        self.db.rollback()
        self.tag = uuid.uuid4().hex[:6]

    def test_supplier_phone_by_country(self):
        from sqlalchemy import text
        from routers import pharmacy as ph
        sid = ph.pharmacy_suppliers_create(request=REQ, db=self.db, user=USER, payload={
            "supplier_name": f"Gulf Pharma {self.tag}", "phone": "+971 50 123 4567", "phone_country_code": "+971"})["supplier_id"]
        row = self.db.execute(text("SELECT phone, phone_country_code FROM pharmacy_suppliers WHERE id = :i"), {"i": sid}).fetchone()
        self.assertEqual((row.phone, row.phone_country_code), ("501234567", "+971"))
        with self.assertRaises(HTTPException):
            ph.pharmacy_suppliers_update(sid, request=REQ, db=self.db, user=USER, payload={"phone": "5012345678", "phone_country_code": "+971"})
        self.db.rollback()
        # Updating another field keeps the stored number and code.
        ph.pharmacy_suppliers_update(sid, request=REQ, db=self.db, user=USER, payload={"contact_person": "Omar"})
        row = self.db.execute(text("SELECT phone, phone_country_code FROM pharmacy_suppliers WHERE id = :i"), {"i": sid}).fetchone()
        self.assertEqual((row.phone, row.phone_country_code), ("501234567", "+971"))

    def test_insurance_helpline_accepts_toll_free(self):
        out = api.insurance_providers_create(request=REQ, db=self.db, user=USER, payload={
            "name": f"Care Insure {self.tag}", "contact_phone": "1800-425-3800", "contact_phone_country_code": "+91"})
        self.assertEqual((out["provider"]["contact_phone"], out["provider"]["contact_phone_country_code"]), ("18004253800", "+91"))

    def test_lab_walkin_mobile_by_country(self):
        svc = lq.create_diag_service(self.db, {"code": f"PH-{self.tag}", "name": "CBC", "service_type": "LAB", "rate": 100})
        oid = lq.create_diag_order(self.db, {"sale_type": "EXTERNAL", "walkin_name": "Tan", "walkin_mobile": "81234567",
                                             "walkin_country_code": "+65", "items": [{"service_id": svc}]})
        order = lq.get_diag_order(self.db, oid)
        self.assertEqual((order["walkin_mobile"], order["walkin_country_code"]), ("81234567", "+65"))
        with self.assertRaises(ValueError):
            lq.create_diag_order(self.db, {"sale_type": "EXTERNAL", "walkin_name": "Tan", "walkin_mobile": "81234567",
                                           "walkin_country_code": "+91", "items": [{"service_id": svc}]})
        self.db.rollback()

    def test_staff_phone_code_and_promote_keeps_details(self):
        import security
        from routers import auth as auth_api
        username = f"ph_{self.tag}"
        result = security.signup_employee(self.db, {
            "username": username, "password": "Str0ng!Passw0rd", "full_name": "Asha Staff", "email": f"{username}@example.com",
            "phone": "501234567", "phone_country_code": "+971", "emergency_contact": "9876543210",
            "emergency_contact_country_code": "+91", "department": "Lab", "job_role": "Lab Technician",
        }, hospital_id=self.hospital_id)
        self.assertTrue(result["success"], result)
        emp_id = result["employee_id"]
        emp = lq.get_employee(self.db, employee_id=emp_id)
        self.assertEqual((emp["phone"], emp["phone_country_code"], emp["emergency_contact"]), ("501234567", "+971", "9876543210"))
        bad = security.signup_employee(self.db, {"username": f"{username}x", "password": "Str0ng!Passw0rd",
                                                 "phone": "50123", "phone_country_code": "+971"}, hospital_id=self.hospital_id)
        self.assertFalse(bad["success"])
        # Promote sends only role fields: everything else must survive.
        auth_api.admin_promote_user(emp_id, db=self.db)
        emp = lq.get_employee(self.db, employee_id=emp_id)
        self.assertEqual((emp["user_type"], emp["full_name"], emp["email"], emp["phone"], emp["phone_country_code"], emp["department"], emp["status"]),
                         ("super_admin", "Asha Staff", f"{username}@example.com", "501234567", "+971", "Lab", "active"))


if __name__ == "__main__":
    unittest.main()
