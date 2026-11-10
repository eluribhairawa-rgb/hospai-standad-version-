"""Consultation fees come from the Doctor Scheduling master, never from the booking screen.

resolve_consultation_fee() decides the fee for an appointment from:
  - the doctor's schedule row (consultation_fee / review_fee), the same row the
    /api/op/doctors list shows,
  - fee_kind sent by the screen: "consultation" (default), "review" (review / follow-up
    rate) or "free_followup" (no charge, only when the patient had a completed visit in
    the last FREE_FOLLOWUP_DAYS days, the rule Registration Desk already shows),
  - emergency visits with a duty doctor who is not in the master are booked at 0 and
    billed through the emergency workflow.
Whatever amount the screen sends is ignored, so a fee cannot be typed over.
"""

from datetime import date, datetime
import legacy_queries as lq
from legacy_sql import get_connection

FREE_FOLLOWUP_DAYS = 7
FEE_KINDS = ('consultation', 'review', 'free_followup')


def normalize_fee_kind(value) -> str:
    kind = str(value or '').strip().lower().replace('-', '_').replace(' ', '_')
    if kind in ('review', 'follow_up', 'followup', 'revisit', 're_visit'):
        return 'review'
    if kind in ('free_followup', 'free_follow_up', 'free'):
        return 'free_followup'
    return 'consultation'


def doctor_fees(db, doctor_name):
    """(consultation_fee, review_fee) from the doctor's schedule, or None if not in the master."""
    name = str(doctor_name or '').strip()
    if not name:
        return None
    rows = lq.list_doctor_schedules(db, doctor_name=name)
    if not rows:
        return None
    row = dict(rows[0])
    return (row.get('consultation_fee'), row.get('review_fee'))


def eligible_for_free_followup(db, patient_id, on_date=None) -> bool:
    """A completed visit within FREE_FOLLOWUP_DAYS days before the appointment date."""
    if not patient_id:
        return False
    with get_connection(db) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT appointment_date FROM appointments WHERE patient_id = ? AND status = 'completed' ORDER BY appointment_date DESC LIMIT 1",
            (patient_id,),
        )
        row = cursor.fetchone()
        if not row:
            return False
        last = row['appointment_date'] if isinstance(row, dict) else row[0]
        if not last:
            return False
        if isinstance(last, str):
            clean = last.split('T')[0].split(' ')[0]
            try:
                last = datetime.strptime(clean, '%Y-%m-%d').date()
            except Exception:
                return False
        elif isinstance(last, datetime):
            last = last.date()
        today = on_date or date.today()
        if isinstance(today, str):
            clean = today.split('T')[0].split(' ')[0]
            try:
                today = datetime.strptime(clean, '%Y-%m-%d').date()
            except Exception:
                today = date.today()
        elif isinstance(today, datetime):
            today = today.date()
        return 0 <= (today - last).days <= FREE_FOLLOWUP_DAYS


def resolve_consultation_fee(db, payload) -> tuple[float, str]:
    """(fee, fee_kind) for the booking. Raises ValueError with a user-facing message."""
    visit_type = str(payload.get('visit_type') or '').strip().lower()
    kind = normalize_fee_kind(payload.get('fee_kind') or payload.get('appointment_kind'))
    doctor = str(payload.get('doctor_name') or '').strip()
    fees = doctor_fees(db, doctor) if doctor else None

    if visit_type == 'emergency':
        if not fees:
            return (0.0, 'emergency')

    if not fees:
        if doctor:
            raise ValueError(f"Doctor '{doctor}' has no consultation fee in Doctor Scheduling. Add the doctor's schedule and fee first.")
        raise ValueError('Select the consulting doctor.')

    if kind == 'free_followup':
        appt_date = None
        try:
            appt_date = date.fromisoformat(str(payload.get('appointment_date') or '')[:10])
        except (ValueError, TypeError):
            pass
        if eligible_for_free_followup(db, payload.get('patient_id'), appt_date):
            return (0.0, kind)
        raise ValueError(f'A free follow-up needs a completed visit within the last {FREE_FOLLOWUP_DAYS} days.')

    consultation_fee, review_fee = fees
    if kind == 'review':
        fee = review_fee if review_fee is not None else consultation_fee
    else:
        fee = consultation_fee if consultation_fee is not None else review_fee

    return (float(fee or 0), kind)

