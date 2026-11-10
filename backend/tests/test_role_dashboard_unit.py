"""Role-based dashboard: persona selection and admin isolation (no database needed).

Run from backend/:  .venv/bin/python -m unittest tests.test_role_dashboard_unit -v
"""
import os
import sys
import unittest
from unittest import mock

os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/unit_tests")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import role_dashboard  # noqa: E402
import deps  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from routers import nursing  # noqa: E402
import security  # noqa: E402
from routers import clinical  # noqa: E402


def login(job_role, modules=(), user_type="normal", doctor_name=None, username="emp"):
    """A session profile exactly as security.resolve_user_profile builds it."""
    return security.resolve_user_profile({
        "username": username, "user_type": user_type, "module_access": list(modules),
        "job_role": job_role, "doctor_name": doctor_name, "full_name": username.title(),
    })


class PersonaTests(unittest.TestCase):
    def persona(self, *args, **kwargs):
        return role_dashboard.resolve_persona(login(*args, **kwargs))

    def test_admin_and_super_admin_keep_executive_dashboard(self):
        self.assertEqual(self.persona("Admin", user_type="admin"), "admin")
        self.assertEqual(self.persona("System Admin", user_type="super_admin"), "admin")
        # Even an admin whose job title is Doctor stays on the executive dashboard.
        self.assertEqual(self.persona("Doctor", user_type="admin", doctor_name="Dr. A"), "admin")

    def test_job_titles(self):
        self.assertEqual(self.persona("Doctor", ["dashboard"], doctor_name="Dr. A"), "doctor")
        self.assertEqual(self.persona("Nurse", ["dashboard", "ip-management"]), "nurse")
        self.assertEqual(self.persona("Receptionist", ["dashboard", "patient-registration"]), "receptionist")
        self.assertEqual(self.persona("Pharmacist", ["dashboard", "pharmacy"]), "pharmacist")
        self.assertEqual(self.persona("Lab Technician", ["dashboard", "lab-diagnostics"]), "lab_technician")
        self.assertEqual(self.persona("Billing Executive", ["dashboard", "billing"]), "billing")

    def test_generic_titles_fall_back_to_granted_modules(self):
        self.assertEqual(self.persona("Technician", ["dashboard", "lab-diagnostics"]), "lab_technician")
        self.assertEqual(self.persona("Technician", ["dashboard", "pharmacy"]), "pharmacist")
        self.assertEqual(self.persona("Other", ["dashboard", "billing"]), "billing")
        self.assertEqual(self.persona("Other", ["dashboard", "patient-registration"]), "receptionist")
        self.assertEqual(self.persona("Other", ["dashboard", "patients"]), "staff")  # read-only access
        self.assertEqual(self.persona("Other", ["dashboard"]), "staff")

    def test_title_without_module_permission_does_not_unlock_module_data(self):
        # A "Pharmacist" without the Pharmacy module must not get pharmacy figures.
        self.assertNotEqual(self.persona("Pharmacist", ["dashboard"]), "pharmacist")
        self.assertNotEqual(self.persona("Lab Technician", ["dashboard"]), "lab_technician")
        self.assertNotEqual(self.persona("Billing", ["dashboard"]), "billing")


class BuildTests(unittest.TestCase):
    def test_admin_build_runs_no_queries(self):
        db = mock.MagicMock()
        out = role_dashboard.build_role_dashboard(db, login("Admin", user_type="admin"), "2026-11-05")
        self.assertEqual(out["persona"], "admin")
        db.execute.assert_not_called()

    def test_unlinked_doctor_gets_no_hospital_wide_data(self):
        db = mock.MagicMock()
        out = role_dashboard.build_role_dashboard(db, login("Doctor", ["dashboard"]), "2026-11-05")
        self.assertEqual(out["persona"], "doctor")
        self.assertEqual(out["kpis"], [])
        self.assertTrue(out["notice"])
        db.execute.assert_not_called()

    def test_doctor_queries_are_bound_to_own_name(self):
        db = mock.MagicMock()
        db.execute.return_value.fetchall.return_value = []
        db.execute.return_value.fetchone.return_value = (0,)
        user = login("Doctor", ["dashboard"], doctor_name="  Dr. Anil Rao ")
        out = role_dashboard.build_role_dashboard(db, user, "2026-11-05")
        self.assertEqual(out["persona"], "doctor")
        for call in db.execute.call_args_list:
            params = call.args[1]
            self.assertEqual(params.get("d"), "dr. anil rao")  # every query is scoped to this doctor
            self.assertIn("= :d", str(call.args[0]))

    def test_bad_date_falls_back_to_today(self):
        self.assertEqual(role_dashboard._parse_date("not-a-date"), role_dashboard.lq.current_ist_datetime().date().isoformat())
        self.assertEqual(role_dashboard._parse_date("2026-01-02T10:00"), "2026-01-02")

    def test_endpoint_is_registered_with_patients_read(self):
        routes = {r.path: r for r in clinical.router.routes}
        self.assertIn("/api/dashboard/my", routes)


class ExpandedTitleTests(unittest.TestCase):
    def persona(self, *args, **kwargs):
        return role_dashboard.resolve_persona(login(*args, **kwargs))

    def test_new_job_titles_map_to_roles_when_module_granted(self):
        self.assertEqual(self.persona("Radiology Technician", ["dashboard", "lab-diagnostics"]), "lab_technician")
        self.assertEqual(self.persona("Phlebotomist", ["dashboard", "lab-diagnostics"]), "lab_technician")
        self.assertEqual(self.persona("Billing Executive", ["dashboard", "billing"]), "billing")
        self.assertEqual(self.persona("Cashier", ["dashboard", "billing"]), "billing")
        self.assertEqual(self.persona("Head Nurse", ["dashboard", "ip-management"]), "nurse")
        self.assertEqual(self.persona("Front Office Executive", ["dashboard", "queue-management"]), "receptionist")

    def test_titles_never_unlock_modules(self):
        self.assertEqual(self.persona("Nurse", ["dashboard"]), "staff")
        self.assertEqual(self.persona("Receptionist", ["dashboard", "patients"]), "staff")
        self.assertEqual(self.persona("Radiology Technician", ["dashboard"]), "staff")
        # Title without its module falls back to the module the login does hold.
        self.assertEqual(self.persona("Pharmacist", ["dashboard", "billing"]), "billing")

    def test_only_exact_doctor_title_gets_doctor_dashboard(self):
        self.assertEqual(self.persona("Doctor", ["dashboard"], doctor_name="Dr. A"), "doctor")
        self.assertEqual(self.persona("Consultant Surgeon", ["dashboard"]), "staff")


class HospitalOverviewAccessTests(unittest.TestCase):
    def test_who_can_view_hospital_wide_figures(self):
        self.assertTrue(deps.can_view_hospital_overview(login("Admin", user_type="admin")))
        self.assertTrue(deps.can_view_hospital_overview(login("Admin", user_type="super_admin")))
        # Explicitly Admin / Super Admin only: no module grant unlocks hospital-wide figures,
        # including Reports & Day Close ("reports") and every module at once.
        self.assertFalse(deps.can_view_hospital_overview(login("Accountant", ["dashboard", "reports"])))
        self.assertFalse(deps.can_view_hospital_overview(login("Accountant", ["dashboard", "analytics"])))
        self.assertFalse(deps.can_view_hospital_overview(login("Other", ["dashboard", "reports", "billing", "finance"])))
        self.assertFalse(deps.can_view_hospital_overview(login("Other", list(security.ASSIGNABLE_MODULES))))
        self.assertFalse(deps.can_view_hospital_overview(login("Admin", ["dashboard", "reports"])))  # title is not a role
        for job, mods in (("Nurse", ["dashboard", "ip-management"]), ("Doctor", ["dashboard"]),
                          ("Pharmacist", ["dashboard", "pharmacy"]), ("Billing Executive", ["dashboard", "billing"])):
            self.assertFalse(deps.can_view_hospital_overview(login(job, mods)), job)
        self.assertFalse(deps.can_view_hospital_overview(None))

    def test_dependency_rejects_and_keeps_base_permission(self):
        guard = deps.require_hospital_overview("patients.read")
        with self.assertRaises(HTTPException) as ctx:
            guard(login("Nurse", ["dashboard", "ip-management"]))
        self.assertEqual(ctx.exception.status_code, 403)
        admin = login("Admin", user_type="admin")
        self.assertIs(guard(admin), admin)
        # reports.read alone (no patients.read) still fails the original permission.
        with self.assertRaises(HTTPException):
            guard(login("Other", ["reports"]))

    def test_summary_analytics_and_exports_use_the_guard(self):
        from routers import clinical, reports_exports
        def guarded(router, path):
            route = next(r for r in router.routes if r.path == path)
            return any(isinstance(d.call, deps.require_hospital_overview) for d in route.dependant.dependencies)
        for path in ("/api/dashboard/hospital-summary", "/api/dashboard/summary", "/api/hospital/summary",
                     "/api/dashboard/analytics"):
            self.assertTrue(guarded(clinical.router, path), path)
        for path in ("/api/dashboard/export/pdf", "/api/dashboard/print/pdf", "/api/dashboard/export/csv",
                     "/api/dashboard/export/excel"):
            self.assertTrue(guarded(reports_exports.router, path), path)

    def test_dashboard_analytics_accepts_date_parameter(self):
        with mock.patch.object(clinical.lq, "get_dashboard_analytics", return_value={"patients_trend": []}) as get_analytics:
            clinical.dashboard_analytics(
                request=mock.MagicMock(),
                days=14,
                date="2026-10-15",
                db=mock.MagicMock(),
                user=login("Admin", user_type="admin"),
                hospital_id=1,
            )
            get_analytics.assert_called_once_with(
                mock.ANY,
                days=14,
                include_employee=True,
                hospital_id=1,
                selected_date="2026-10-15",
            )


class NursingAccessTests(unittest.TestCase):
    def test_only_admins_and_nursing_supervisors_manage(self):
        self.assertTrue(nursing.can_manage(login("Admin", user_type="admin")))
        self.assertTrue(nursing.can_manage(login("Head Nurse", ["dashboard", "ip-management"])))
        self.assertTrue(nursing.can_manage(login("Nursing Supervisor", ["dashboard", "ip-management"])))
        self.assertFalse(nursing.can_manage(login("Nurse", ["dashboard", "ip-management"])))
        self.assertFalse(nursing.can_manage(login("Head Nurse", ["dashboard"])))  # no IPD module
        self.assertFalse(nursing.can_manage(login("Head Receptionist", ["dashboard", "ip-management"])))

    def test_view_requires_ipd_module(self):
        with self.assertRaises(HTTPException):
            nursing.require_ipd_view(login("Nurse", ["dashboard"]))
        self.assertTrue(nursing.require_ipd_view(login("Nurse", ["dashboard", "ip-management"])))


if __name__ == "__main__":
    unittest.main()
