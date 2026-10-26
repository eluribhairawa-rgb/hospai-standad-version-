from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database import get_db
from deps import require_permissions, current_hospital_id, get_current_user
from common import rows_to_dicts, validate_required_fields, log_audit_event, client_ip, normalize_department_name
import legacy_queries as lq
import security

router = APIRouter(prefix="/api", tags=["lab-ot-accounts-hr"])


# ------------------------------------------------------------------- lab --

@router.get("/lab/vendors")
def lab_vendors_list(db: Session = Depends(get_db), user: dict = Depends(require_permissions("lab.read"))):
    return {"vendors": rows_to_dicts(lq.list_lab_vendors(db))}


@router.post("/lab/vendors")
def lab_vendors_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("lab.write"))):
    validate_required_fields(payload, ["vendor_name"])
    vendor_id = lq.create_lab_vendor(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "lab_vendors", str(vendor_id), {"vendor_name": payload.get("vendor_name")})
    return {"vendor_id": vendor_id}


@router.put("/lab/vendors/{vendor_id}")
def lab_vendors_update(vendor_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("lab.write"))):
    if not lq.update_lab_vendor(db, vendor_id, payload):
        raise HTTPException(status_code=404, detail="Vendor not found")
    log_audit_event(db, user, client_ip(request), "update", "lab_vendors", str(vendor_id), {"vendor_id": vendor_id})
    return {"status": "ok"}


@router.delete("/lab/vendors/{vendor_id}")
def lab_vendors_delete(vendor_id: int, request: Request, db: Session = Depends(get_db), user: dict = Depends(require_permissions("lab.write"))):
    if not lq.delete_lab_vendor(db, vendor_id):
        raise HTTPException(status_code=404, detail="Vendor not found")
    log_audit_event(db, user, client_ip(request), "delete", "lab_vendors", str(vendor_id), {"vendor_id": vendor_id})
    return {"status": "ok"}


@router.get("/lab/categories")
def lab_categories_list(type: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("lab.read"))):
    return {"categories": lq.get_lab_categories(db, type)}


@router.post("/lab/categories")
def lab_categories_create(payload: dict = Body(...), db: Session = Depends(get_db), user: dict = Depends(require_permissions("lab.write"))):
    category_type = payload.get("category_type")
    category_name = payload.get("category_name")
    if not category_type or not category_name:
        raise HTTPException(status_code=400, detail="category_type and category_name are required")
    category_id = lq.add_lab_category(db, category_type, category_name)
    if not category_id:
        raise HTTPException(status_code=400, detail="Category already exists or invalid data")
    return {"status": "ok", "category_id": category_id}


@router.delete("/lab/categories")
def lab_categories_delete(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("lab.write"))):
    category_type = payload.get("category_type")
    category_name = payload.get("category_name")
    if not category_type or not category_name:
        raise HTTPException(status_code=400, detail="category_type and category_name are required")
    if not lq.delete_lab_category(db, category_type, category_name):
        raise HTTPException(status_code=404, detail="Category not found or could not be deleted")
    log_audit_event(db, user, client_ip(request), "delete", "lab_categories", category_name, {"category_type": category_type, "category_name": category_name})
    return {"status": "ok"}


@router.get("/lab/diagnostics")
def lab_diagnostics_list(patient_id: str | None = None, doctor_name: str | None = None, db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("lab.read")), hospital_id: int = Depends(current_hospital_id)):
    if patient_id:
        patient = lq.get_patient(db, patient_id, hospital_id=hospital_id)
        patient_id = patient["patient_id"] if patient else patient_id
    return {"diagnostics": rows_to_dicts(lq.list_diagnostics(db, patient_id=patient_id, doctor_name=doctor_name))}


@router.post("/lab/diagnostics")
def lab_diagnostics_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("lab.write")), hospital_id: int = Depends(current_hospital_id)):
    if payload.get("patient_id"):
        patient = lq.get_patient(db, payload.get("patient_id"), hospital_id=hospital_id)
        if patient:
            payload["patient_id"] = patient["patient_id"]
    validate_required_fields(payload, ["test_name", "amount"])
    diagnostic_id = lq.create_diagnostic_record(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "diagnostics", str(diagnostic_id), {"test_name": payload.get("test_name")})
    return {"diagnostic_id": diagnostic_id}


@router.put("/lab/diagnostics/{diagnostic_id}")
def lab_diagnostics_update(diagnostic_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("lab.write"))):
    if not lq.update_diagnostic_record(db, diagnostic_id, payload):
        raise HTTPException(status_code=404, detail="Diagnostic record not found")
    log_audit_event(db, user, client_ip(request), "update", "diagnostics", str(diagnostic_id), {"diagnostic_id": diagnostic_id})
    return {"status": "ok"}


@router.delete("/lab/diagnostics/{diagnostic_id}")
def lab_diagnostics_delete(diagnostic_id: int, request: Request, db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("lab.write"))):
    if not lq.delete_diagnostic_record(db, diagnostic_id):
        raise HTTPException(status_code=404, detail="Diagnostic record not found")
    log_audit_event(db, user, client_ip(request), "delete", "diagnostics", str(diagnostic_id), {"diagnostic_id": diagnostic_id})
    return {"status": "ok"}


@router.get("/lab/diagnostics/{diagnostic_id}/payments")
def lab_diagnostic_payments_get(diagnostic_id: int, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    if "lab.read" not in security.resolve_user_permissions(user):
        raise HTTPException(status_code=403, detail={"error": "Forbidden", "required_permissions": ["lab.read"]})
    return {"payments": rows_to_dicts(lq.list_diagnostic_payments(db, diagnostic_id))}


@router.post("/lab/diagnostics/{diagnostic_id}/payments")
def lab_diagnostic_payments_post(diagnostic_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                  user: dict = Depends(get_current_user)):
    if "lab.write" not in security.resolve_user_permissions(user):
        raise HTTPException(status_code=403, detail={"error": "Forbidden", "required_permissions": ["lab.write"]})
    validate_required_fields(payload, ["amount", "payment_mode"])
    try:
        amount = float(payload["amount"])
        result = lq.collect_diagnostic_payment(
            db, diagnostic_id=diagnostic_id, amount=amount, payment_mode=payload["payment_mode"],
            transaction_ref=payload.get("transaction_ref"), operator_name=user.get("username") or "System",
            remarks=payload.get("notes"),
        )
        log_audit_event(db, user, client_ip(request), "collect_payment", "diagnostics", str(diagnostic_id),
                         {"amount": amount, "payment_mode": payload["payment_mode"]})
        return {"status": "ok", "record": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {e}")


@router.get("/lab/summary")
def lab_summary(db: Session = Depends(get_db), user: dict = Depends(require_permissions("lab.read"))):
    return lq.get_diagnostic_summary(db)


# -------------------------------------------------------------------- ot --

@router.get("/ot/theatres")
def ot_theatres_list(db: Session = Depends(get_db), user: dict = Depends(require_permissions("ot.read"))):
    return {"theatres": rows_to_dicts(lq.list_ot_theatres(db))}


@router.post("/ot/theatres")
def ot_theatres_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("ot.write"))):
    validate_required_fields(payload, ["theatre_code", "theatre_name"])
    theatre_id = lq.create_ot_theatre(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "ot_theatres", str(theatre_id), {"theatre_code": payload.get("theatre_code")})
    return {"theatre_id": theatre_id}


@router.put("/ot/theatres/{theatre_id}")
def ot_theatres_update(theatre_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                        user: dict = Depends(require_permissions("ot.write"))):
    if not lq.update_ot_theatre(db, theatre_id, payload):
        raise HTTPException(status_code=404, detail="Theatre not found")
    log_audit_event(db, user, client_ip(request), "update", "ot_theatres", str(theatre_id), {"theatre_id": theatre_id})
    return {"status": "ok"}


@router.delete("/ot/theatres/{theatre_id}")
def ot_theatres_delete(theatre_id: int, request: Request, db: Session = Depends(get_db), user: dict = Depends(require_permissions("ot.write"))):
    if not lq.delete_ot_theatre(db, theatre_id):
        raise HTTPException(status_code=404, detail="Theatre not found")
    log_audit_event(db, user, client_ip(request), "delete", "ot_theatres", str(theatre_id), {"theatre_id": theatre_id})
    return {"status": "ok"}


@router.get("/ot/surgeries")
def ot_surgeries_list(theatre_id: int | None = None, status: str | None = None, db: Session = Depends(get_db),
                       user: dict = Depends(require_permissions("ot.read"))):
    return {"surgeries": rows_to_dicts(lq.list_ot_surgeries(db, theatre_id=theatre_id, status=status))}


@router.post("/ot/surgeries")
def ot_surgeries_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("ot.write"))):
    validate_required_fields(payload, ["theatre_id", "procedure_name", "surgeon_name", "scheduled_start"])
    surgery_id = lq.create_ot_surgery(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "ot_surgeries", str(surgery_id), {"procedure_name": payload.get("procedure_name")})
    return {"surgery_id": surgery_id}


@router.put("/ot/surgeries/{surgery_id}")
def ot_surgeries_update(surgery_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                         user: dict = Depends(require_permissions("ot.write"))):
    if not lq.update_ot_surgery(db, surgery_id, payload):
        raise HTTPException(status_code=404, detail="Surgery not found")
    log_audit_event(db, user, client_ip(request), "update", "ot_surgeries", str(surgery_id), {"surgery_id": surgery_id})
    return {"status": "ok"}


@router.delete("/ot/surgeries/{surgery_id}")
def ot_surgeries_delete(surgery_id: int, request: Request, db: Session = Depends(get_db), user: dict = Depends(require_permissions("ot.write"))):
    if not lq.delete_ot_surgery(db, surgery_id):
        raise HTTPException(status_code=404, detail="Surgery not found")
    log_audit_event(db, user, client_ip(request), "delete", "ot_surgeries", str(surgery_id), {"surgery_id": surgery_id})
    return {"status": "ok"}


@router.get("/ot/summary")
def ot_summary(db: Session = Depends(get_db), user: dict = Depends(require_permissions("ot.read"))):
    return lq.get_ot_summary(db)


# -------------------------------------------------------------- accounts --

@router.get("/accounts/summary")
def accounts_summary(db: Session = Depends(get_db), user: dict = Depends(require_permissions("accounts.read"))):
    return lq.get_accounts_summary(db)


@router.get("/accounts/ledger")
def accounts_ledger_list(entry_type: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("accounts.read"))):
    return {"entries": rows_to_dicts(lq.list_account_ledger_entries(db, entry_type=entry_type))}


@router.post("/accounts/ledger")
def accounts_ledger_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("accounts.write"))):
    validate_required_fields(payload, ["entry_date", "entry_type", "category", "amount"])
    entry_id = lq.create_account_ledger_entry(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "accounts_ledger", str(entry_id), {"category": payload.get("category")})
    return {"entry_id": entry_id}


@router.put("/accounts/ledger/{entry_id}")
def accounts_ledger_update(entry_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("accounts.write"))):
    if not lq.update_account_ledger_entry(db, entry_id, payload):
        raise HTTPException(status_code=404, detail="Ledger entry not found")
    log_audit_event(db, user, client_ip(request), "update", "accounts_ledger", str(entry_id), {"entry_id": entry_id})
    return {"status": "ok"}


@router.delete("/accounts/ledger/{entry_id}")
def accounts_ledger_delete(entry_id: int, request: Request, db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("accounts.write"))):
    if not lq.delete_account_ledger_entry(db, entry_id):
        raise HTTPException(status_code=404, detail="Ledger entry not found")
    log_audit_event(db, user, client_ip(request), "delete", "accounts_ledger", str(entry_id), {"entry_id": entry_id})
    return {"status": "ok"}


@router.get("/accounts/vendors")
def accounts_vendor_payments_list(vendor_name: str | None = None, db: Session = Depends(get_db),
                                   user: dict = Depends(require_permissions("accounts.read"))):
    return {"payments": rows_to_dicts(lq.list_vendor_payments(db, vendor_name=vendor_name))}


@router.post("/accounts/vendors")
def accounts_vendor_payments_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                     user: dict = Depends(require_permissions("accounts.write"))):
    validate_required_fields(payload, ["vendor_name", "amount", "payment_date"])
    payment_id = lq.create_vendor_payment(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "vendor_payments", str(payment_id), {"vendor_name": payload.get("vendor_name")})
    return {"payment_id": payment_id}


@router.put("/accounts/vendors/{payment_id}")
def accounts_vendor_payments_update(payment_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                     user: dict = Depends(require_permissions("accounts.write"))):
    if not lq.update_vendor_payment(db, payment_id, payload):
        raise HTTPException(status_code=404, detail="Vendor payment not found")
    log_audit_event(db, user, client_ip(request), "update", "vendor_payments", str(payment_id), {"payment_id": payment_id})
    return {"status": "ok"}


@router.delete("/accounts/vendors/{payment_id}")
def accounts_vendor_payments_delete(payment_id: int, request: Request, db: Session = Depends(get_db),
                                     user: dict = Depends(require_permissions("accounts.write"))):
    if not lq.delete_vendor_payment(db, payment_id):
        raise HTTPException(status_code=404, detail="Vendor payment not found")
    log_audit_event(db, user, client_ip(request), "delete", "vendor_payments", str(payment_id), {"payment_id": payment_id})
    return {"status": "ok"}


@router.get("/accounts/doctors")
def accounts_doctor_payouts_list(doctor_name: str | None = None, db: Session = Depends(get_db),
                                  user: dict = Depends(require_permissions("accounts.read"))):
    return {"payouts": rows_to_dicts(lq.list_doctor_payouts(db, doctor_name=doctor_name))}


@router.post("/accounts/doctors")
def accounts_doctor_payouts_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("accounts.write"))):
    validate_required_fields(payload, ["doctor_name", "payout_month", "amount"])
    try:
        payout_id = lq.create_doctor_payout(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log_audit_event(db, user, client_ip(request), "create", "doctor_payouts", str(payout_id), {"doctor_name": payload.get("doctor_name")})
    return {"payout_id": payout_id}


@router.put("/accounts/doctors/{payout_id}")
def accounts_doctor_payouts_update(payout_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("accounts.write"))):
    try:
        updated = lq.update_doctor_payout(db, payout_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not updated:
        raise HTTPException(status_code=404, detail="Doctor payout not found")
    log_audit_event(db, user, client_ip(request), "update", "doctor_payouts", str(payout_id), {"payout_id": payout_id})
    return {"status": "ok"}


@router.delete("/accounts/doctors/{payout_id}")
def accounts_doctor_payouts_delete(payout_id: int, request: Request, db: Session = Depends(get_db),
                                    user: dict = Depends(require_permissions("accounts.write"))):
    if not lq.delete_doctor_payout(db, payout_id):
        raise HTTPException(status_code=404, detail="Doctor payout not found")
    log_audit_event(db, user, client_ip(request), "delete", "doctor_payouts", str(payout_id), {"payout_id": payout_id})
    return {"status": "ok"}


# ------------------------------------------------------------------- hr --

@router.get("/hr/departments")
def hr_departments_list(db: Session = Depends(get_db), user: dict = Depends(require_permissions("hr.read")),
                         hospital_id: int = Depends(current_hospital_id)):
    return {"departments": rows_to_dicts(lq.list_departments(db, hospital_id=hospital_id))}


@router.post("/hr/departments")
def hr_departments_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("hr.write")), hospital_id: int = Depends(current_hospital_id)):
    department_name = normalize_department_name(payload.get("department_name"))
    existing = next(
        (row for row in rows_to_dicts(lq.list_departments(db, hospital_id=hospital_id))
         if (row.get("department_name") or "").strip().lower() == department_name.lower()), None,
    )
    if existing:
        return {"department_id": existing.get("id"), "department_name": existing.get("department_name"), "already_exists": True}
    department_id = lq.create_department(db, {
        "department_name": department_name, "mapped_head_employee_id": payload.get("mapped_head_employee_id"),
    }, hospital_id=hospital_id)
    log_audit_event(db, user, client_ip(request), "create", "departments", str(department_id), {"department_name": department_name})
    return {"department_id": department_id, "department_name": department_name}


@router.put("/hr/departments/{department_id}")
def hr_departments_update(department_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("hr.write")), hospital_id: int = Depends(current_hospital_id)):
    if "department_name" in payload:
        payload["department_name"] = normalize_department_name(payload.get("department_name"))
        duplicate = next(
            (row for row in rows_to_dicts(lq.list_departments(db, hospital_id=hospital_id))
             if row.get("id") != department_id and (row.get("department_name") or "").strip().lower() == payload["department_name"].lower()), None,
        )
        if duplicate:
            raise HTTPException(status_code=409, detail="Department already exists")
    if not lq.update_department(db, department_id, payload, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Department not found")
    log_audit_event(db, user, client_ip(request), "update", "departments", str(department_id), {"department_id": department_id})
    return {"status": "ok"}


@router.delete("/hr/departments/{department_id}")
def hr_departments_delete(department_id: int, request: Request, db: Session = Depends(get_db),
                           user: dict = Depends(require_permissions("hr.write")), hospital_id: int = Depends(current_hospital_id)):
    if not lq.delete_department(db, department_id, hospital_id=hospital_id):
        raise HTTPException(status_code=404, detail="Department not found")
    log_audit_event(db, user, client_ip(request), "delete", "departments", str(department_id), {"department_id": department_id})
    return {"status": "ok"}


@router.get("/hr/attendance")
def hr_attendance_list(employee_id: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("hr.read"))):
    return {"attendance": rows_to_dicts(lq.list_attendance(db, employee_id=employee_id))}


@router.post("/hr/attendance")
def hr_attendance_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("hr.write"))):
    validate_required_fields(payload, ["employee_id", "attendance_date", "status"])
    attendance_id = lq.create_attendance(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "attendance", str(attendance_id), {"employee_id": payload.get("employee_id")})
    return {"attendance_id": attendance_id}


@router.put("/hr/attendance/{attendance_id}")
def hr_attendance_update(attendance_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("hr.write"))):
    if not lq.update_attendance_record(db, attendance_id, payload):
        raise HTTPException(status_code=404, detail="Attendance record not found")
    log_audit_event(db, user, client_ip(request), "update", "attendance", str(attendance_id), {"attendance_id": attendance_id})
    return {"status": "ok"}


@router.delete("/hr/attendance/{attendance_id}")
def hr_attendance_delete(attendance_id: int, request: Request, db: Session = Depends(get_db),
                          user: dict = Depends(require_permissions("hr.write"))):
    if not lq.delete_attendance_record(db, attendance_id):
        raise HTTPException(status_code=404, detail="Attendance record not found")
    log_audit_event(db, user, client_ip(request), "delete", "attendance", str(attendance_id), {"attendance_id": attendance_id})
    return {"status": "ok"}


@router.get("/hr/payroll")
def hr_payroll_list(employee_id: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("hr.read"))):
    return {"payroll": rows_to_dicts(lq.list_payroll(db, employee_id=employee_id))}


@router.post("/hr/payroll")
def hr_payroll_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                       user: dict = Depends(require_permissions("hr.write"))):
    validate_required_fields(payload, ["employee_id", "payroll_month", "basic_salary"])
    payroll_id = lq.create_payroll_record(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "payroll", str(payroll_id), {"employee_id": payload.get("employee_id")})
    return {"payroll_id": payroll_id}


@router.put("/hr/payroll/{payroll_id}")
def hr_payroll_update(payroll_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                       user: dict = Depends(require_permissions("hr.write"))):
    if not lq.update_payroll_record(db, payroll_id, payload):
        raise HTTPException(status_code=404, detail="Payroll record not found")
    log_audit_event(db, user, client_ip(request), "update", "payroll", str(payroll_id), {"payroll_id": payroll_id})
    return {"status": "ok"}


@router.delete("/hr/payroll/{payroll_id}")
def hr_payroll_delete(payroll_id: int, request: Request, db: Session = Depends(get_db),
                       user: dict = Depends(require_permissions("hr.write"))):
    if not lq.delete_payroll_record(db, payroll_id):
        raise HTTPException(status_code=404, detail="Payroll record not found")
    log_audit_event(db, user, client_ip(request), "delete", "payroll", str(payroll_id), {"payroll_id": payroll_id})
    return {"status": "ok"}


@router.get("/hr/leaves")
def hr_leaves_list(employee_id: str | None = None, db: Session = Depends(get_db), user: dict = Depends(require_permissions("hr.read"))):
    return {"leaves": rows_to_dicts(lq.list_leave_requests(db, employee_id=employee_id))}


@router.post("/hr/leaves")
def hr_leaves_create(request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                      user: dict = Depends(require_permissions("hr.write"))):
    validate_required_fields(payload, ["employee_id", "leave_type", "start_date", "end_date"])
    leave_id = lq.create_leave_request(db, payload)
    log_audit_event(db, user, client_ip(request), "create", "leave_requests", str(leave_id), {"employee_id": payload.get("employee_id")})
    return {"leave_id": leave_id}


@router.post("/hr/leaves/{leave_id}/status")
def hr_leave_status_update(leave_id: int, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_permissions("hr.write"))):
    validate_required_fields(payload, ["status"])
    if not lq.update_leave_status(db, leave_id, payload.get("status", "pending"), user.get("username")):
        raise HTTPException(status_code=404, detail="Leave request not found")
    log_audit_event(db, user, client_ip(request), "update", "leave_requests", str(leave_id), {"status": payload.get("status")})
    return {"status": "ok"}


@router.delete("/hr/leaves/{leave_id}")
def hr_leaves_delete(leave_id: int, request: Request, db: Session = Depends(get_db), user: dict = Depends(require_permissions("hr.write"))):
    if not lq.delete_leave_request(db, leave_id):
        raise HTTPException(status_code=404, detail="Leave request not found")
    log_audit_event(db, user, client_ip(request), "delete", "leave_requests", str(leave_id), {"leave_id": leave_id})
    return {"status": "ok"}


# ---------------------------------------------------------------- audit --

@router.get("/audit/logs")
def audit_logs_list(module: str | None = None, limit: int = 100, db: Session = Depends(get_db),
                     user: dict = Depends(require_permissions("audit.read"))):
    return {"logs": rows_to_dicts(lq.get_audit_logs(db, module_name=module, limit=limit))}
