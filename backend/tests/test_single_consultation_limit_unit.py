import os
import sys
import unittest
from unittest import mock
from fastapi import HTTPException
from starlette.requests import Request

os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/unit_tests")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from routers import clinical
import legacy_queries as lq


def make_request(path="/api/appointments/1"):
    return Request({
        "type": "http",
        "method": "PUT",
        "path": path,
        "headers": [],
        "client": ("127.0.0.1", 1234),
    })


class SingleConsultationLimitTests(unittest.TestCase):
    def test_appointments_update_raises_400_when_active_consultation_present(self):
        user = {
            "username": "receptionist",
            "user_type": "normal",
            "job_role": "Receptionist",
            "doctor_name": None,
            "permissions": ["patients.write"],
        }
        with mock.patch.object(
            lq,
            "update_appointment",
            side_effect=ValueError("Already a patient is present in consultation."),
        ):
            with self.assertRaises(HTTPException) as ctx:
                clinical.appointments_update(
                    102,
                    request=make_request("/api/appointments/102"),
                    payload={"status": "in_consultation"},
                    db=mock.MagicMock(),
                    user=user,
                )
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertEqual(ctx.exception.detail, "Already a patient is present in consultation.")

    def test_update_appointment_blocks_second_in_consultation(self):
        # Mock connection and cursor
        mock_cursor = mock.MagicMock()
        # 1st call: SELECT * FROM appointments WHERE id = ? -> existing appointment 102
        mock_cursor.fetchone.side_effect = [
            {"id": 102, "doctor_name": "Dr. Smith", "status": "checked_in", "department": "General"},
            {"id": 101, "patient_name": "John Doe", "token_no": "T1"},  # already active consultation found
        ]

        mock_cursor.rowcount = 1
        mock_conn = mock.MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with mock.patch("legacy_queries.get_connection") as mock_get_conn:
            mock_get_conn.return_value.__enter__.return_value = mock_conn

            with self.assertRaises(ValueError) as ctx:
                lq.update_appointment(
                    mock.MagicMock(),
                    102,
                    {"status": "in_consultation", "doctor_name": "Dr. Smith"},
                )
            self.assertEqual(str(ctx.exception), "Already a patient is present in consultation.")

    def test_update_appointment_allows_if_no_active_consultation(self):
        mock_cursor = mock.MagicMock()
        existing_appt = {
            "id": 102,
            "patient_id": 1,
            "patient_name": "Jane",
            "visit_type": "OP",
            "department": "General",
            "doctor_name": "Dr. Smith",
            "appointment_date": "2026-11-11",
            "status": "checked_in",
            "notes": "",
            "appointment_kind": "new",
            "follow_up_for": None,
            "reminder_sent_at": None,
            "no_show_marked": 0,
            "consultation_fee": 100,
        }
        # 1st call: existing appointment 102
        # 2nd call: check existing active consultation -> returns None
        mock_cursor.fetchone.side_effect = [
            existing_appt,
            None,  # no other appointment in consultation
        ]
        mock_cursor.fetchall.return_value = []

        mock_cursor.rowcount = 1
        mock_conn = mock.MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with mock.patch("legacy_queries.get_connection") as mock_get_conn:
            mock_get_conn.return_value.__enter__.return_value = mock_conn

            result = lq.update_appointment(
                mock.MagicMock(),
                102,
                {"status": "in_consultation", "doctor_name": "Dr. Smith"},
            )
            self.assertTrue(result)


if __name__ == "__main__":
    unittest.main()
