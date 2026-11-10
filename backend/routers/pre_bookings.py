import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Body
from sqlalchemy import text, desc, asc, or_
from sqlalchemy.orm import Session

from database import get_db
from deps import require_permissions, current_hospital_id
from phone import validate_phone, clean_country_code
from models import PreBooking
from common import log_audit_event, client_ip

router = APIRouter(prefix="/api/pre-bookings", tags=["pre-bookings"])


def _pre_booking_to_dict(pb: PreBooking) -> dict:
    return {
        "id": pb.id,
        "hospital_id": pb.hospital_id,
        "patient_name": pb.patient_name,
        "phone": pb.phone,
        "phone_country_code": pb.phone_country_code or "+91",
        "dob": pb.dob.isoformat() if pb.dob else None,
        "age": pb.age,
        "email": pb.email,
        "appointment_date": pb.appointment_date.isoformat() if pb.appointment_date else None,
        "appointment_time": pb.appointment_time,
        "department": pb.department,
        "doctor_name": pb.doctor_name,
        "reason": pb.reason,
        "status": pb.status or "Confirmed",
        "patient_id": pb.patient_id,
        "appointment_id": pb.appointment_id,
        "created_at": pb.created_at.isoformat() if pb.created_at else None,
        "updated_at": pb.updated_at.isoformat() if pb.updated_at else None,
    }


@router.get("")
def list_pre_bookings(
    request: Request,
    date: Optional[str] = Query(None, description="Filter by appointment date YYYY-MM-DD"),
    month: Optional[str] = Query(None, description="Filter by month YYYY-MM"),
    status: Optional[str] = Query(None, description="Filter by status, or 'all'"),
    q: Optional[str] = Query(None, description="Search query by name, phone, doctor, reason"),
    db: Session = Depends(get_db),
    user: dict = Depends(require_permissions("patients.read")),
    hospital_id: int = Depends(current_hospital_id),
):
    query = db.query(PreBooking).filter(PreBooking.hospital_id == hospital_id)

    if date:
        try:
            filter_date = datetime.date.fromisoformat(date)
            query = query.filter(PreBooking.appointment_date == filter_date)
        except ValueError:
            pass

    if month:
        try:
            # e.g. "2026-11"
            parts = month.split("-")
            year, m = int(parts[0]), int(parts[1])
            start_date = datetime.date(year, m, 1)
            if m == 12:
                end_date = datetime.date(year + 1, 1, 1)
            else:
                end_date = datetime.date(year, m + 1, 1)
            query = query.filter(PreBooking.appointment_date >= start_date, PreBooking.appointment_date < end_date)
        except (ValueError, IndexError):
            pass

    if status and status.lower() != "all":
        query = query.filter(PreBooking.status.ilike(status))

    if q and q.strip():
        search_term = f"%{q.strip()}%"
        query = query.filter(
            or_(
                PreBooking.patient_name.ilike(search_term),
                PreBooking.phone.ilike(search_term),
                PreBooking.doctor_name.ilike(search_term),
                PreBooking.department.ilike(search_term),
                PreBooking.reason.ilike(search_term),
                PreBooking.patient_id.ilike(search_term),
            )
        )

    # Order by appointment date ascending (nulls last), then appointment time ascending, then id desc
    results = query.order_by(
        PreBooking.appointment_date.asc().nullslast(),
        PreBooking.appointment_time.asc().nullslast(),
        PreBooking.id.desc(),
    ).all()

    return {"pre_bookings": [_pre_booking_to_dict(pb) for pb in results]}


@router.post("")
def create_pre_booking(
    request: Request,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user: dict = Depends(require_permissions("patients.write")),
    hospital_id: int = Depends(current_hospital_id),
):
    patient_name = str(payload.get("patient_name") or payload.get("name") or "").strip()
    if not patient_name:
        raise HTTPException(status_code=400, detail={"error": "Patient name is required."})

    raw_phone = str(payload.get("phone") or payload.get("mobile") or "").strip()
    country_code = clean_country_code(payload.get("phone_country_code") or payload.get("country_code") or "+91")

    digits, validated_code, phone_error = validate_phone(
        raw_phone, country_code=country_code, required=True, label="Mobile number"
    )
    if phone_error:
        raise HTTPException(status_code=400, detail={"error": phone_error, "field": "phone"})

    # Parse optional fields
    dob_val = None
    if payload.get("dob"):
        try:
            dob_val = datetime.date.fromisoformat(str(payload.get("dob")).strip()[:10])
        except (ValueError, TypeError):
            pass

    age_val = None
    if payload.get("age") is not None and str(payload.get("age")).strip() != "":
        try:
            age_val = int(float(str(payload.get("age")).strip()))
        except (ValueError, TypeError):
            pass

    appointment_date_val = None
    if payload.get("appointment_date"):
        try:
            appointment_date_val = datetime.date.fromisoformat(str(payload.get("appointment_date")).strip()[:10])
        except (ValueError, TypeError):
            pass

    email_val = str(payload.get("email") or "").strip() or None
    appointment_time_val = str(payload.get("appointment_time") or "").strip() or None
    department_val = str(payload.get("department") or "").strip() or None
    doctor_name_val = str(payload.get("doctor_name") or "").strip() or None
    reason_val = str(payload.get("reason") or "").strip() or None

    new_pb = PreBooking(
        hospital_id=hospital_id,
        patient_name=patient_name,
        phone=digits,
        phone_country_code=validated_code,
        dob=dob_val,
        age=age_val,
        email=email_val,
        appointment_date=appointment_date_val,
        appointment_time=appointment_time_val,
        department=department_val,
        doctor_name=doctor_name_val,
        reason=reason_val,
        status="Confirmed",
    )
    db.add(new_pb)
    db.commit()
    db.refresh(new_pb)

    log_audit_event(
        db,
        user,
        client_ip(request),
        "create",
        "pre_bookings",
        str(new_pb.id),
        {"patient_name": patient_name, "phone": digits},
    )

    return {"message": "Pre-booking created successfully.", "pre_booking": _pre_booking_to_dict(new_pb)}


@router.get("/{pre_booking_id}")
def get_pre_booking(
    pre_booking_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(require_permissions("patients.read")),
    hospital_id: int = Depends(current_hospital_id),
):
    pb = db.query(PreBooking).filter(PreBooking.id == pre_booking_id, PreBooking.hospital_id == hospital_id).first()
    if not pb:
        raise HTTPException(status_code=404, detail="Pre-booking not found.")
    return {"pre_booking": _pre_booking_to_dict(pb)}


@router.put("/{pre_booking_id}")
def update_pre_booking(
    pre_booking_id: int,
    request: Request,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user: dict = Depends(require_permissions("patients.write")),
    hospital_id: int = Depends(current_hospital_id),
):
    pb = db.query(PreBooking).filter(PreBooking.id == pre_booking_id, PreBooking.hospital_id == hospital_id).first()
    if not pb:
        raise HTTPException(status_code=404, detail="Pre-booking not found.")

    if "patient_name" in payload and payload["patient_name"]:
        pb.patient_name = str(payload["patient_name"]).strip()

    if "phone" in payload and payload["phone"]:
        cc = clean_country_code(payload.get("phone_country_code") or pb.phone_country_code)
        digits, validated_code, err = validate_phone(str(payload["phone"]), country_code=cc, required=True)
        if err:
            raise HTTPException(status_code=400, detail={"error": err, "field": "phone"})
        pb.phone = digits
        pb.phone_country_code = validated_code

    if "dob" in payload:
        if payload["dob"]:
            try:
                pb.dob = datetime.date.fromisoformat(str(payload["dob"]).strip()[:10])
            except (ValueError, TypeError):
                pass
        else:
            pb.dob = None

    if "age" in payload:
        if payload["age"] is not None and str(payload["age"]).strip() != "":
            try:
                pb.age = int(float(str(payload["age"]).strip()))
            except (ValueError, TypeError):
                pass
        else:
            pb.age = None

    if "email" in payload:
        pb.email = str(payload["email"]).strip() or None

    if "appointment_date" in payload:
        if payload["appointment_date"]:
            try:
                pb.appointment_date = datetime.date.fromisoformat(str(payload["appointment_date"]).strip()[:10])
            except (ValueError, TypeError):
                pass
        else:
            pb.appointment_date = None

    if "appointment_time" in payload:
        pb.appointment_time = str(payload["appointment_time"]).strip() or None

    if "department" in payload:
        pb.department = str(payload["department"]).strip() or None

    if "doctor_name" in payload:
        pb.doctor_name = str(payload["doctor_name"]).strip() or None

    if "reason" in payload:
        pb.reason = str(payload["reason"]).strip() or None

    if "status" in payload:
        pb.status = str(payload["status"]).strip() or pb.status

    pb.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(pb)

    return {"message": "Pre-booking updated.", "pre_booking": _pre_booking_to_dict(pb)}


@router.put("/{pre_booking_id}/convert")
def convert_pre_booking_to_patient(
    pre_booking_id: int,
    request: Request,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user: dict = Depends(require_permissions("patients.write")),
    hospital_id: int = Depends(current_hospital_id),
):
    pb = db.query(PreBooking).filter(PreBooking.id == pre_booking_id, PreBooking.hospital_id == hospital_id).first()
    if not pb:
        raise HTTPException(status_code=404, detail="Pre-booking not found.")

    patient_id = payload.get("patient_id")
    if not patient_id:
        raise HTTPException(status_code=400, detail="patient_id is required.")

    pb.patient_id = str(patient_id).strip()
    pb.status = "Registered"
    if payload.get("appointment_id"):
        try:
            pb.appointment_id = int(payload["appointment_id"])
        except (ValueError, TypeError):
            pass

    pb.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(pb)

    log_audit_event(
        db,
        user,
        client_ip(request),
        "convert",
        "pre_bookings",
        str(pb.id),
        {"patient_id": pb.patient_id},
    )

    return {"message": "Pre-booking converted to patient successfully.", "pre_booking": _pre_booking_to_dict(pb)}


@router.delete("/{pre_booking_id}")
def cancel_or_delete_pre_booking(
    pre_booking_id: int,
    request: Request,
    hard_delete: bool = Query(False, description="Set true to delete row completely, false to mark Cancelled"),
    db: Session = Depends(get_db),
    user: dict = Depends(require_permissions("patients.write")),
    hospital_id: int = Depends(current_hospital_id),
):
    pb = db.query(PreBooking).filter(PreBooking.id == pre_booking_id, PreBooking.hospital_id == hospital_id).first()
    if not pb:
        raise HTTPException(status_code=404, detail="Pre-booking not found.")

    if hard_delete:
        db.delete(pb)
        db.commit()
        return {"message": f"Pre-booking #{pre_booking_id} permanently deleted."}
    else:
        pb.status = "Cancelled"
        pb.updated_at = datetime.datetime.utcnow()
        db.commit()
        return {"message": f"Pre-booking #{pre_booking_id} marked as Cancelled."}
