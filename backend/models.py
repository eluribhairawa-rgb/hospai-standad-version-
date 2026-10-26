from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, Double, ForeignKeyConstraint, Index, Integer, LargeBinary, PrimaryKeyConstraint, REAL, Text, UniqueConstraint, text
from typing import Optional
import datetime

from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

class Base(DeclarativeBase):
    pass


class AccountsLedger(Base):
    __tablename__ = 'accounts_ledger'
    __table_args__ = (
        CheckConstraint("entry_type = ANY (ARRAY['income'::text, 'expense'::text, 'adjustment'::text])", name='accounts_ledger_entry_type_check'),
        PrimaryKeyConstraint('id', name='accounts_ledger_pkey'),
        Index('idx_accounts_ledger_type', 'entry_type')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    entry_type: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[float] = mapped_column(Double(53), nullable=False)
    reference_no: Mapped[Optional[str]] = mapped_column(Text)
    counterparty_name: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class AdmissionConsumption(Base):
    __tablename__ = 'admission_consumption'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='admission_consumption_pkey'),
        UniqueConstraint('bill_number', name='admission_consumption_bill_number_key'),
        Index('idx_admission_consumption_bed', 'bed_allocation_id'),
        Index('idx_admission_consumption_bed_grid', 'bed_allocation_id', 'created_at'),
        Index('idx_admission_consumption_patient', 'patient_id', 'created_at')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bed_allocation_id: Mapped[int] = mapped_column(Integer, nullable=False)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    item_category: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'Consumable'::text"))
    item_name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[float] = mapped_column(Double(53), nullable=False, server_default=text('0'))
    unit_price: Mapped[float] = mapped_column(Double(53), nullable=False, server_default=text('0'))
    total_amount: Mapped[float] = mapped_column(Double(53), nullable=False, server_default=text('0'))
    batch_no: Mapped[Optional[str]] = mapped_column(Text)
    unit: Mapped[Optional[str]] = mapped_column(Text)
    strip_count: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    tablet_count: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    bill_number: Mapped[Optional[str]] = mapped_column(Text)
    generated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class Appointments(Base):
    __tablename__ = 'appointments'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['scheduled'::text, 'checked_in'::text, 'in_consultation'::text, 'in-consultation'::text, 'completed'::text, 'cancelled'::text, 'skipped'::text, 'no_show'::text, 'waiting'::text])", name='appointments_status_check'),
        PrimaryKeyConstraint('id', name='appointments_pkey'),
        Index('idx_appointments_bed_grid_patient_date', 'patient_id', 'appointment_date'),
        Index('idx_appointments_date', 'appointment_date'),
        Index('idx_appointments_doctor', 'doctor_name'),
        Index('idx_appointments_patient', 'patient_id'),
        Index('idx_appointments_status', 'status')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_name: Mapped[str] = mapped_column(Text, nullable=False)
    visit_type: Mapped[str] = mapped_column(Text, nullable=False)
    appointment_date: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False)
    token_no: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'scheduled'::text"))
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    department: Mapped[Optional[str]] = mapped_column(Text)
    doctor_name: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    appointment_kind: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'new'::text"))
    follow_up_for: Mapped[Optional[int]] = mapped_column(Integer)
    reminder_sent_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    no_show_marked: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    consultation_fee: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))


class Attendance(Base):
    __tablename__ = 'attendance'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['present'::text, 'absent'::text, 'leave'::text, 'holiday'::text, 'weekly_off'::text, 'half_day'::text, 'late'::text, 'work_from_home'::text, 'on_duty'::text])", name='attendance_status_check'),
        PrimaryKeyConstraint('id', name='attendance_pkey'),
        Index('idx_attendance_employee', 'employee_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(Text, nullable=False)
    attendance_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    in_time: Mapped[Optional[str]] = mapped_column(Text)
    out_time: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)


class AuditLogs(Base):
    __tablename__ = 'audit_logs'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='audit_logs_pkey'),
        Index('idx_audit_module', 'module_name')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    module_name: Mapped[str] = mapped_column(Text, nullable=False)
    actor_username: Mapped[Optional[str]] = mapped_column(Text)
    entity_key: Mapped[Optional[str]] = mapped_column(Text)
    payload: Mapped[Optional[str]] = mapped_column(Text)
    ip_address: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class BedAllocations(Base):
    __tablename__ = 'bed_allocations'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='bed_allocations_pkey'),
        Index('idx_bed_allocations_active_bed', 'ward', 'room_no', 'bed_no', 'status', 'released_at'),
        Index('idx_bed_allocations_grid_bed', 'ward', 'room_no', 'bed_no', 'bed_type'),
        Index('idx_bed_allocations_grid_patient', 'patient_id', 'admission_id'),
        Index('idx_bed_allocations_grid_status', 'status', 'released_at', 'allocated_at')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    admission_id: Mapped[int] = mapped_column(Integer, nullable=False)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    ward: Mapped[Optional[str]] = mapped_column(Text)
    room_no: Mapped[Optional[str]] = mapped_column(Text)
    bed_no: Mapped[Optional[str]] = mapped_column(Text)
    allocated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    released_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    daily_charge: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0.0'))
    number_of_days: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('1'))
    total_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0.0'))
    discount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0.0'))
    additional_charges: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0.0'))
    bed_type: Mapped[Optional[str]] = mapped_column(Text)
    expected_discharge_date: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'active'::text"))
    assigned_doctor: Mapped[Optional[str]] = mapped_column(Text)
    amount_per_day: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    total_days: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))


class BedConfig(Base):
    __tablename__ = 'bed_config'
    __table_args__ = (
        PrimaryKeyConstraint('hospital_id', name='bed_config_pkey'),
    )

    hospital_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    capacity: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('50'))


class BedConfigs(Base):
    __tablename__ = 'bed_configs'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='bed_configs_pkey'),
        UniqueConstraint('hospital_id', name='bed_configs_hospital_id_key'),
        Index('idx_bed_configs_hospital', 'hospital_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    available_beds: Mapped[Optional[int]] = mapped_column(Integer)


class Certificates(Base):
    __tablename__ = 'certificates'
    __table_args__ = (
        CheckConstraint("certificate_type = ANY (ARRAY['discharge_summary'::text, 'medical_certificate'::text, 'insurance_document'::text, 'fit_to_work'::text])", name='certificates_certificate_type_check'),
        PrimaryKeyConstraint('id', name='certificates_pkey'),
        Index('idx_certificates_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    certificate_type: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    issued_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class ChatbotAuditLogs(Base):
    __tablename__ = 'chatbot_audit_logs'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='chatbot_audit_logs_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[Optional[str]] = mapped_column(Text)
    role: Mapped[Optional[str]] = mapped_column(Text)
    question: Mapped[Optional[str]] = mapped_column(Text)
    intent: Mapped[Optional[str]] = mapped_column(Text)
    action_taken: Mapped[Optional[str]] = mapped_column(Text)
    response_status: Mapped[Optional[str]] = mapped_column(Text)
    execution_time_ms: Mapped[Optional[int]] = mapped_column(Integer)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DepartmentMaster(Base):
    __tablename__ = 'department_master'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='department_master_pkey'),
        UniqueConstraint('hospital_id', 'department_name', name='department_master_hospital_id_department_name_key'),
        Index('idx_department_master_hospital', 'hospital_id'),
        Index('idx_department_master_hospital_name', 'hospital_id', 'department_name', unique=True)
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    department_name: Mapped[str] = mapped_column(Text, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    mapped_head_employee_id: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    doctor_name: Mapped[Optional[str]] = mapped_column(Text)


class DiagEquipment(Base):
    __tablename__ = 'diag_equipment'
    __table_args__ = (
        CheckConstraint("operational_status = ANY (ARRAY['ready'::text, 'qc_hold'::text, 'maintenance'::text, 'down'::text])", name='diag_equipment_operational_status_check'),
        PrimaryKeyConstraint('id', name='diag_equipment_pkey'),
        UniqueConstraint('asset_id', name='diag_equipment_asset_id_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_id: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    operational_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'ready'::text"))
    type: Mapped[Optional[str]] = mapped_column(Text)
    location: Mapped[Optional[str]] = mapped_column(Text)
    model: Mapped[Optional[str]] = mapped_column(Text)
    serial_no: Mapped[Optional[str]] = mapped_column(Text)
    responsible_staff: Mapped[Optional[str]] = mapped_column(Text)
    next_maintenance_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    next_calibration_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    diag_equipment_maintenance: Mapped[list['DiagEquipmentMaintenance']] = relationship('DiagEquipmentMaintenance', back_populates='equipment')
    diag_qc_runs: Mapped[list['DiagQcRuns']] = relationship('DiagQcRuns', back_populates='equipment')
    diag_qc_holds: Mapped[list['DiagQcHolds']] = relationship('DiagQcHolds', back_populates='equipment')


class DiagOrders(Base):
    __tablename__ = 'diag_orders'
    __table_args__ = (
        CheckConstraint("encounter_type = ANY (ARRAY['OP'::text, 'IP'::text, 'EMERGENCY'::text, 'EXTERNAL'::text])", name='diag_orders_encounter_type_check'),
        CheckConstraint("priority = ANY (ARRAY['Routine'::text, 'Urgent'::text, 'STAT'::text])", name='diag_orders_priority_check'),
        CheckConstraint("status = ANY (ARRAY['draft'::text, 'confirmed'::text, 'cancelled'::text])", name='diag_orders_status_check'),
        PrimaryKeyConstraint('id', name='diag_orders_pkey'),
        UniqueConstraint('order_no', name='diag_orders_order_no_key'),
        Index('idx_diag_orders_admission', 'admission_id'),
        Index('idx_diag_orders_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_no: Mapped[str] = mapped_column(Text, nullable=False)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    encounter_type: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'Routine'::text"))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'draft'::text"))
    appointment_id: Mapped[Optional[int]] = mapped_column(Integer)
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    external_source: Mapped[Optional[str]] = mapped_column(Text)
    referring_clinician: Mapped[Optional[str]] = mapped_column(Text)
    clinical_indication: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    source_document_id: Mapped[Optional[int]] = mapped_column(Integer)
    invoice_id: Mapped[Optional[int]] = mapped_column(Integer)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    confirmed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)

    diag_order_items: Mapped[list['DiagOrderItems']] = relationship('DiagOrderItems', back_populates='order')


class DiagPackages(Base):
    __tablename__ = 'diag_packages'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='diag_packages_pkey'),
        UniqueConstraint('code', name='diag_packages_code_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    rate: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text('0'))
    active: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('true'))
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    diag_package_items: Mapped[list['DiagPackageItems']] = relationship('DiagPackageItems', back_populates='package')


class DiagReagentLots(Base):
    __tablename__ = 'diag_reagent_lots'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['available'::text, 'quarantined'::text, 'expired'::text, 'consumed'::text])", name='diag_reagent_lots_status_check'),
        PrimaryKeyConstraint('id', name='diag_reagent_lots_pkey'),
        UniqueConstraint('item_name', 'lot_no', name='diag_reagent_lots_item_name_lot_no_key'),
        Index('idx_diag_reagent_expiry', 'expiry_date')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    item_name: Mapped[str] = mapped_column(Text, nullable=False)
    lot_no: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text('0'))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'available'::text"))
    unit: Mapped[Optional[str]] = mapped_column(Text)
    expiry_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    storage_location: Mapped[Optional[str]] = mapped_column(Text)
    supplier_ref: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    diag_stock_movements: Mapped[list['DiagStockMovements']] = relationship('DiagStockMovements', back_populates='reagent_lot')


class DiagReportTemplates(Base):
    __tablename__ = 'diag_report_templates'
    __table_args__ = (
        CheckConstraint("layout = ANY (ARRAY['structured'::text, 'narrative'::text])", name='diag_report_templates_layout_check'),
        CheckConstraint("report_type = ANY (ARRAY['LAB'::text, 'IMAGING'::text])", name='diag_report_templates_report_type_check'),
        PrimaryKeyConstraint('id', name='diag_report_templates_pkey'),
        UniqueConstraint('code', name='diag_report_templates_code_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    report_type: Mapped[str] = mapped_column(Text, nullable=False)
    layout: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'structured'::text"))
    active: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('true'))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DiagServices(Base):
    __tablename__ = 'diag_services'
    __table_args__ = (
        CheckConstraint("service_type = ANY (ARRAY['LAB'::text, 'IMAGING'::text, 'OTHER'::text])", name='diag_services_service_type_check'),
        PrimaryKeyConstraint('id', name='diag_services_pkey'),
        UniqueConstraint('code', name='diag_services_code_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    service_type: Mapped[str] = mapped_column(Text, nullable=False)
    rate: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text('0'))
    department: Mapped[Optional[str]] = mapped_column(Text)
    active: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('true'))
    turnaround_time: Mapped[Optional[str]] = mapped_column(Text)
    turnaround_hours: Mapped[Optional[float]] = mapped_column(REAL)
    preparation_requirements: Mapped[Optional[str]] = mapped_column(Text)
    specimen_type: Mapped[Optional[str]] = mapped_column(Text)
    container_type: Mapped[Optional[str]] = mapped_column(Text)
    modality: Mapped[Optional[str]] = mapped_column(Text)
    body_region: Mapped[Optional[str]] = mapped_column(Text)
    laterality: Mapped[Optional[str]] = mapped_column(Text)
    requires_scheduling: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('false'))
    report_template: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'generic'::text"))
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    diag_order_items: Mapped[list['DiagOrderItems']] = relationship('DiagOrderItems', back_populates='service')
    diag_package_items: Mapped[list['DiagPackageItems']] = relationship('DiagPackageItems', back_populates='service')
    diag_service_parameters: Mapped[list['DiagServiceParameters']] = relationship('DiagServiceParameters', back_populates='service')
    diag_service_pricing_history: Mapped[list['DiagServicePricingHistory']] = relationship('DiagServicePricingHistory', back_populates='service')


class Diagnostics(Base):
    __tablename__ = 'diagnostics'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['paid'::text, 'partial'::text, 'due'::text])", name='diagnostics_status_check'),
        PrimaryKeyConstraint('id', name='diagnostics_pkey'),
        Index('idx_diagnostics_created_at', 'created_at'),
        Index('idx_diagnostics_invoice_no', 'invoice_no'),
        Index('idx_diagnostics_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    test_name: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[float] = mapped_column(Double(53), nullable=False)
    invoice_no: Mapped[Optional[str]] = mapped_column(Text)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    vendor_id: Mapped[Optional[int]] = mapped_column(Integer)
    doctor_name: Mapped[Optional[str]] = mapped_column(Text)
    paid_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    due_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'due'::text"))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    sample_barcode: Mapped[Optional[str]] = mapped_column(Text)
    order_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'ordered'::text"))
    collected_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    reported_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    age: Mapped[Optional[int]] = mapped_column(Integer)
    gender: Mapped[Optional[str]] = mapped_column(Text)
    department: Mapped[Optional[str]] = mapped_column(Text)
    visit_type: Mapped[Optional[str]] = mapped_column(Text)
    visit_id: Mapped[Optional[str]] = mapped_column(Text)
    bill_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    due_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    payment_mode: Mapped[Optional[str]] = mapped_column(Text)
    transaction_id: Mapped[Optional[str]] = mapped_column(Text)
    discount_percentage: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    discount_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    tax_percentage: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    tax_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    report_delivery_mode: Mapped[Optional[str]] = mapped_column(Text)
    report_delivery_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    quantity: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('1'))
    unit_rate: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))

    diagnostic_payments: Mapped[list['DiagnosticPayments']] = relationship('DiagnosticPayments', back_populates='diagnostic')


class DischargePreparations(Base):
    __tablename__ = 'discharge_preparations'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='discharge_preparations_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    final_vitals_checked: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    iv_removed: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    dressing_done: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    medicines_explained: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    patient_education_done: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    discharge_file_ready: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    wheelchair_requested: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    status: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    prepared_by: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DoctorPayouts(Base):
    __tablename__ = 'doctor_payouts'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['pending'::text, 'partial'::text, 'paid'::text])", name='doctor_payouts_status_check'),
        PrimaryKeyConstraint('id', name='doctor_payouts_pkey'),
        Index('idx_doctor_payouts_doctor', 'doctor_name')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doctor_name: Mapped[str] = mapped_column(Text, nullable=False)
    payout_month: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[float] = mapped_column(Double(53), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    paid_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    due_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    paid_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    doctor_payout_payments: Mapped[list['DoctorPayoutPayments']] = relationship('DoctorPayoutPayments', back_populates='payout')


class DoctorRoundAttachments(Base):
    __tablename__ = 'doctor_round_attachments'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='doctor_round_attachments_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    round_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    doc_type: Mapped[Optional[str]] = mapped_column(Text)
    file_name: Mapped[Optional[str]] = mapped_column(Text)
    file_path: Mapped[Optional[str]] = mapped_column(Text)
    uploaded_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DoctorRoundFollowups(Base):
    __tablename__ = 'doctor_round_followups'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='doctor_round_followups_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    round_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    next_round_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    follow_up_time: Mapped[Optional[str]] = mapped_column(Text)
    responsible_doctor: Mapped[Optional[str]] = mapped_column(Text)
    instructions: Mapped[Optional[str]] = mapped_column(Text)
    alerts: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DoctorRoundInstructions(Base):
    __tablename__ = 'doctor_round_instructions'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='doctor_round_instructions_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    round_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    instruction_text: Mapped[Optional[str]] = mapped_column(Text)
    acknowledged_by: Mapped[Optional[str]] = mapped_column(Text)
    acknowledged_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    completed_by: Mapped[Optional[str]] = mapped_column(Text)
    completed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    status: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DoctorRoundInvestigations(Base):
    __tablename__ = 'doctor_round_investigations'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='doctor_round_investigations_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    round_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    test_type: Mapped[Optional[str]] = mapped_column(Text)
    test_name: Mapped[Optional[str]] = mapped_column(Text)
    priority: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DoctorRoundMedications(Base):
    __tablename__ = 'doctor_round_medications'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='doctor_round_medications_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    round_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    medicine_name: Mapped[Optional[str]] = mapped_column(Text)
    strength: Mapped[Optional[str]] = mapped_column(Text)
    dosage: Mapped[Optional[str]] = mapped_column(Text)
    frequency: Mapped[Optional[str]] = mapped_column(Text)
    route: Mapped[Optional[str]] = mapped_column(Text)
    start_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    end_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    priority: Mapped[Optional[str]] = mapped_column(Text)
    given_during_round: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    administered_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    administered_by: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DoctorRoundProcedures(Base):
    __tablename__ = 'doctor_round_procedures'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='doctor_round_procedures_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    round_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    procedure_name: Mapped[Optional[str]] = mapped_column(Text)
    priority: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DoctorRoundSchedules(Base):
    __tablename__ = 'doctor_round_schedules'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='doctor_round_schedules_pkey'),
        Index('idx_dr_round_sch_doc', 'doctor_name')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    doctor_name: Mapped[Optional[str]] = mapped_column(Text)
    department: Mapped[Optional[str]] = mapped_column(Text)
    round_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    start_time: Mapped[Optional[str]] = mapped_column(Text)
    end_time: Mapped[Optional[str]] = mapped_column(Text)
    ward: Mapped[Optional[str]] = mapped_column(Text)
    floor: Mapped[Optional[str]] = mapped_column(Text)
    assigned_nurse: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DoctorRounds(Base):
    __tablename__ = 'doctor_rounds'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='doctor_rounds_pkey'),
        Index('idx_dr_round_pat', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    round_schedule_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    doctor_name: Mapped[Optional[str]] = mapped_column(Text)
    nurse_present: Mapped[Optional[str]] = mapped_column(Text)
    round_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    round_time: Mapped[Optional[str]] = mapped_column(Text)
    patient_complaints: Mapped[Optional[str]] = mapped_column(Text)
    clinical_findings: Mapped[Optional[str]] = mapped_column(Text)
    assessment: Mapped[Optional[str]] = mapped_column(Text)
    diagnosis: Mapped[Optional[str]] = mapped_column(Text)
    progress_notes: Mapped[Optional[str]] = mapped_column(Text)
    patient_condition: Mapped[Optional[str]] = mapped_column(Text)
    next_review_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    doctor_signature: Mapped[Optional[str]] = mapped_column(Text)
    nurse_acknowledgement: Mapped[Optional[str]] = mapped_column(Text)
    acknowledged_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DoctorSchedules(Base):
    __tablename__ = 'doctor_schedules'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['available'::text, 'full'::text, 'leave'::text])", name='doctor_schedules_status_check'),
        PrimaryKeyConstraint('id', name='doctor_schedules_pkey'),
        Index('idx_doctor_schedules_date', 'schedule_date'),
        Index('idx_doctor_schedules_doctor', 'doctor_name')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doctor_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'available'::text"))
    department: Mapped[Optional[str]] = mapped_column(Text)
    schedule_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    start_time: Mapped[Optional[str]] = mapped_column(Text)
    end_time: Mapped[Optional[str]] = mapped_column(Text)
    slot_capacity: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('12'))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    consultation_fee: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    review_fee: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))


class DocumentAccessLogs(Base):
    __tablename__ = 'document_access_logs'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='document_access_logs_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    user_name: Mapped[Optional[str]] = mapped_column(Text)
    ip_address: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DocumentCategories(Base):
    __tablename__ = 'document_categories'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='document_categories_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    module_name: Mapped[Optional[str]] = mapped_column(Text)
    is_active: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('1'))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DocumentDuplicates(Base):
    __tablename__ = 'document_duplicates'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='document_duplicates_pkey'),
        Index('idx_doc_duplicates_document', 'document_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(Integer, nullable=False)
    duplicate_document_id: Mapped[int] = mapped_column(Integer, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    match_type: Mapped[Optional[str]] = mapped_column(Text)
    similarity_score: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'open'::text"))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DocumentModuleLinks(Base):
    __tablename__ = 'document_module_links'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='document_module_links_pkey'),
        Index('idx_doc_links_patient', 'hospital_id', 'patient_id', 'module_name')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(Integer, nullable=False)
    module_name: Mapped[str] = mapped_column(Text, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    module_record_id: Mapped[Optional[str]] = mapped_column(Text)
    link_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'active'::text"))
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DocumentNotifications(Base):
    __tablename__ = 'document_notifications'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='document_notifications_pkey'),
        Index('idx_doc_notifications_status', 'hospital_id', 'status', 'created_at')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    notification_type: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    document_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    module_name: Mapped[Optional[str]] = mapped_column(Text)
    message: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'unread'::text"))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DocumentTags(Base):
    __tablename__ = 'document_tags'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='document_tags_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(Integer, nullable=False)
    tag: Mapped[str] = mapped_column(Text, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DocumentVerification(Base):
    __tablename__ = 'document_verification'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='document_verification_pkey'),
        Index('idx_doc_verification_document', 'document_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    verified_by: Mapped[Optional[str]] = mapped_column(Text)
    verified_data_json: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'{}'::text"))
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    verified_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class DocumentVersions(Base):
    __tablename__ = 'document_versions'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='document_versions_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(Integer, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    version_no: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('1'))
    file_path: Mapped[Optional[str]] = mapped_column(Text)
    file_hash: Mapped[Optional[str]] = mapped_column(Text)
    file_size: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    uploaded_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class EmarRecords(Base):
    __tablename__ = 'emar_records'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['pending'::text, 'given'::text, 'held'::text, 'refused'::text, 'missed'::text, 'discontinued'::text, 'returned'::text])", name='emar_records_status_check'),
        PrimaryKeyConstraint('id', name='emar_records_pkey'),
        Index('idx_emar_admission', 'admission_id'),
        Index('idx_emar_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    scheduled_time: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    indent_id: Mapped[Optional[int]] = mapped_column(Integer)
    indent_item_id: Mapped[Optional[int]] = mapped_column(Integer)
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    dose: Mapped[Optional[str]] = mapped_column(Text)
    route: Mapped[Optional[str]] = mapped_column(Text)
    sale_id: Mapped[Optional[int]] = mapped_column(Integer)
    administered_by: Mapped[Optional[str]] = mapped_column(Text)
    administered_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class Encounters(Base):
    __tablename__ = 'encounters'
    __table_args__ = (
        CheckConstraint("encounter_type = ANY (ARRAY['OP'::text, 'IP'::text, 'EMERGENCY'::text])", name='encounters_encounter_type_check'),
        PrimaryKeyConstraint('id', name='encounters_pkey'),
        Index('idx_encounters_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    encounter_type: Mapped[str] = mapped_column(Text, nullable=False)
    arrival_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    insurance_provider: Mapped[Optional[str]] = mapped_column(Text)
    insurance_policy_no: Mapped[Optional[str]] = mapped_column(Text)
    is_accident: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    referral_source: Mapped[Optional[str]] = mapped_column(Text)
    referral_name: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'active'::text"))
    encounter_no: Mapped[Optional[str]] = mapped_column(Text)
    appointment_id: Mapped[Optional[int]] = mapped_column(Integer)
    chief_complaint: Mapped[Optional[str]] = mapped_column(Text)
    triage_priority: Mapped[Optional[str]] = mapped_column(Text)
    attendant_name: Mapped[Optional[str]] = mapped_column(Text)
    attending_doctor: Mapped[Optional[str]] = mapped_column(Text)
    disposition: Mapped[Optional[str]] = mapped_column(Text)
    disposition_notes: Mapped[Optional[str]] = mapped_column(Text)
    disposition_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    created_by: Mapped[Optional[str]] = mapped_column(Text)


class GoodsReceiptItems(Base):
    __tablename__ = 'goods_receipt_items'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='goods_receipt_items_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    grn_id: Mapped[int] = mapped_column(Integer, nullable=False)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    qty_received: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    qty_accepted: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    qty_damaged: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    medicine_id: Mapped[Optional[int]] = mapped_column(Integer)
    batch_no: Mapped[Optional[str]] = mapped_column(Text)
    expiry_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    stock_source: Mapped[Optional[str]] = mapped_column(Text)
    purchase_price: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    mrp: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    gst_rate: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    unit_type: Mapped[Optional[str]] = mapped_column(Text)
    mfg_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    free_qty: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    selling_price: Mapped[Optional[float]] = mapped_column(REAL)
    discount_pct: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    hsn_code: Mapped[Optional[str]] = mapped_column(Text)
    manufacturer: Mapped[Optional[str]] = mapped_column(Text)
    pack_size: Mapped[Optional[str]] = mapped_column(Text)


class GoodsReceipts(Base):
    __tablename__ = 'goods_receipts'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['draft'::text, 'verified'::text])", name='goods_receipts_status_check'),
        CheckConstraint("stock_source = ANY (ARRAY['CASH'::text, 'INSURANCE'::text])", name='goods_receipts_stock_source_check'),
        PrimaryKeyConstraint('id', name='goods_receipts_pkey'),
        UniqueConstraint('grn_no', name='goods_receipts_grn_no_key'),
        Index('idx_goods_receipts_idempotency', 'idempotency_key', postgresql_where='(idempotency_key IS NOT NULL)', unique=True)
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'draft'::text"))
    grn_no: Mapped[Optional[str]] = mapped_column(Text)
    purchase_order_id: Mapped[Optional[int]] = mapped_column(Integer)
    received_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    supplier_invoice_no: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    stock_source: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'CASH'::text"))
    idempotency_key: Mapped[Optional[str]] = mapped_column(Text)
    idempotency_payload_hash: Mapped[Optional[str]] = mapped_column(Text)
    supplier_id: Mapped[Optional[int]] = mapped_column(Integer)


class HospitalBeds(Base):
    __tablename__ = 'hospital_beds'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='hospital_beds_pkey'),
        UniqueConstraint('ward', 'bed_no', name='hospital_beds_ward_bed_no_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ward: Mapped[str] = mapped_column(Text, nullable=False)
    bed_no: Mapped[str] = mapped_column(Text, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('1'))
    room_no: Mapped[Optional[str]] = mapped_column(Text)
    bed_type: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'Standard'::text"))
    daily_rate: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('1000'))
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'available'::text"))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class Hospitals(Base):
    __tablename__ = 'hospitals'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['active'::text, 'inactive'::text])", name='hospitals_status_check'),
        PrimaryKeyConstraint('id', name='hospitals_pkey'),
        UniqueConstraint('code', name='hospitals_code_key'),
        Index('idx_hospitals_code', 'code')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'::text"))
    disabled_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    disabled_reason: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class IcuMonitoring(Base):
    __tablename__ = 'icu_monitoring'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='icu_monitoring_pkey'),
        Index('idx_nurse_icu_pat', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    record_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    ventilator_mode: Mapped[Optional[str]] = mapped_column(Text)
    fio2: Mapped[Optional[float]] = mapped_column(Double(53))
    peep: Mapped[Optional[float]] = mapped_column(Double(53))
    cardiac_monitor: Mapped[Optional[str]] = mapped_column(Text)
    intake_ml: Mapped[Optional[float]] = mapped_column(Double(53))
    output_ml: Mapped[Optional[float]] = mapped_column(Double(53))
    gcs: Mapped[Optional[int]] = mapped_column(Integer)
    critical_notes: Mapped[Optional[str]] = mapped_column(Text)
    recorded_by: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class IncidentReports(Base):
    __tablename__ = 'incident_reports'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='incident_reports_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    incident_type: Mapped[Optional[str]] = mapped_column(Text)
    incident_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    incident_time: Mapped[Optional[str]] = mapped_column(Text)
    description: Mapped[Optional[str]] = mapped_column(Text)
    action_taken: Mapped[Optional[str]] = mapped_column(Text)
    reporter_name: Mapped[Optional[str]] = mapped_column(Text)
    reporter_role: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class InsuranceClaims(Base):
    __tablename__ = 'insurance_claims'
    __table_args__ = (
        CheckConstraint("claim_status = ANY (ARRAY['draft'::text, 'submitted'::text, 'under_review'::text, 'approved'::text, 'partially_approved'::text, 'rejected'::text, 'settled'::text, 'closed'::text])", name='insurance_claims_claim_status_check'),
        CheckConstraint("settlement_status = ANY (ARRAY['unpaid'::text, 'part_paid'::text, 'paid'::text, 'adjusted'::text])", name='insurance_claims_settlement_status_check'),
        PrimaryKeyConstraint('id', name='insurance_claims_pkey'),
        Index('idx_claims_invoice', 'invoice_id'),
        Index('idx_claims_status', 'claim_status')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    invoice_id: Mapped[int] = mapped_column(Integer, nullable=False)
    insurer_name: Mapped[str] = mapped_column(Text, nullable=False)
    claim_amount: Mapped[float] = mapped_column(Double(53), nullable=False)
    claim_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'submitted'::text"))
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    approved_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    external_ref: Mapped[Optional[str]] = mapped_column(Text)
    submitted_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    settlement_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'unpaid'::text"))
    patient_responsibility: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    adjustments: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    membership_ref: Mapped[Optional[str]] = mapped_column(Text)
    authorization_ref: Mapped[Optional[str]] = mapped_column(Text)
    pharmacy_sale_id: Mapped[Optional[int]] = mapped_column(Integer)


class InsuranceStatusHistory(Base):
    __tablename__ = 'insurance_status_history'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='insurance_status_history_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    new_status: Mapped[str] = mapped_column(Text, nullable=False)
    claim_id: Mapped[Optional[int]] = mapped_column(Integer)
    verification_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    old_status: Mapped[Optional[str]] = mapped_column(Text)
    changed_by: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    changed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class InsuranceVerifications(Base):
    __tablename__ = 'insurance_verifications'
    __table_args__ = (
        CheckConstraint("verification_status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text])", name='insurance_verifications_verification_status_check'),
        PrimaryKeyConstraint('id', name='insurance_verifications_pkey'),
        Index('idx_insurance_verifications_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_name: Mapped[str] = mapped_column(Text, nullable=False)
    insurer_name: Mapped[str] = mapped_column(Text, nullable=False)
    verification_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    policy_number: Mapped[Optional[str]] = mapped_column(Text)
    member_id: Mapped[Optional[str]] = mapped_column(Text)
    coverage_notes: Mapped[Optional[str]] = mapped_column(Text)
    checked_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class InvoiceItems(Base):
    __tablename__ = 'invoice_items'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='invoice_items_pkey'),
        Index('idx_invoice_items_bed_grid_master', 'master_invoice_id', 'module', 'status'),
        Index('idx_invoice_items_master', 'master_invoice_id', 'module', 'status'),
        Index('idx_invoice_items_patient', 'patient_id', 'generated_at'),
        Index('idx_invoice_items_unique_bill', 'master_invoice_id', 'module', 'bill_number', unique=True)
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    master_invoice_id: Mapped[int] = mapped_column(Integer, nullable=False)
    module: Mapped[str] = mapped_column(Text, nullable=False)
    bill_number: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[float] = mapped_column(Double(53), nullable=False, server_default=text('0'))
    paid_amount: Mapped[float] = mapped_column(Double(53), nullable=False, server_default=text('0'))
    due_amount: Mapped[float] = mapped_column(Double(53), nullable=False, server_default=text('0'))
    child_invoice_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    description: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'due'::text"))
    payment_mode: Mapped[Optional[str]] = mapped_column(Text)
    generated_by: Mapped[Optional[str]] = mapped_column(Text)
    generated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class InvoicePayments(Base):
    __tablename__ = 'invoice_payments'
    __table_args__ = (
        CheckConstraint("payment_mode = ANY (ARRAY['cash'::text, 'card'::text, 'upi'::text, 'bank'::text, 'razorpay'::text, 'bank_transfer'::text, 'net_banking'::text, 'mixed_payment'::text, 'cheque'::text])", name='invoice_payments_payment_mode_check'),
        PrimaryKeyConstraint('id', name='invoice_payments_pkey'),
        Index('idx_payments_invoice', 'invoice_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    invoice_id: Mapped[int] = mapped_column(Integer, nullable=False)
    amount: Mapped[float] = mapped_column(Double(53), nullable=False)
    payment_mode: Mapped[str] = mapped_column(Text, nullable=False)
    gateway_ref: Mapped[Optional[str]] = mapped_column(Text)
    converted_from_mode: Mapped[Optional[str]] = mapped_column(Text)
    converted_to_mode: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class Invoices(Base):
    __tablename__ = 'invoices'
    __table_args__ = (
        CheckConstraint("module = ANY (ARRAY['OP'::text, 'IP'::text, 'LAB'::text, 'PHARMACY'::text, 'BED'::text, 'OTHER'::text, 'RADIOLOGY'::text, 'MASTER'::text])", name='invoices_module_check'),
        CheckConstraint("payment_status = ANY (ARRAY['paid'::text, 'partial'::text, 'due'::text, 'refunded'::text])", name='invoices_payment_status_check'),
        PrimaryKeyConstraint('id', name='invoices_pkey'),
        UniqueConstraint('invoice_no', name='invoices_invoice_no_key'),
        Index('idx_invoice_patient', 'patient_id'),
        Index('idx_invoice_status', 'payment_status'),
        Index('idx_invoices_bed_grid_patient', 'patient_id', 'module', 'payment_status'),
        Index('idx_invoices_created', 'created_at'),
        Index('idx_invoices_created_at', 'created_at'),
        Index('idx_invoices_invoice_no', 'invoice_no'),
        Index('idx_invoices_module_source_unique', 'module', 'source_reference', postgresql_where="((source_reference IS NOT NULL) AND (source_reference <> ''::text))", unique=True),
        Index('idx_invoices_op_appointment', 'appointment_id', postgresql_where="((appointment_id IS NOT NULL) AND (module = 'OP'::text))"),
        Index('idx_invoices_patient', 'patient_id', 'created_at'),
        Index('idx_invoices_status_module', 'payment_status', 'module')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    invoice_no: Mapped[str] = mapped_column(Text, nullable=False)
    module: Mapped[str] = mapped_column(Text, nullable=False)
    total_amount: Mapped[float] = mapped_column(Double(53), nullable=False)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    doctor_name: Mapped[Optional[str]] = mapped_column(Text)
    clinic_name: Mapped[Optional[str]] = mapped_column(Text)
    referral_source: Mapped[Optional[str]] = mapped_column(Text)
    subtotal: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    tax: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    discount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    paid_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    due_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    payment_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'due'::text"))
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    invoice_type: Mapped[Optional[str]] = mapped_column(Text)
    source_reference: Mapped[Optional[str]] = mapped_column(Text)
    advance_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    refunded_amount: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    appointment_id: Mapped[Optional[int]] = mapped_column(Integer)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    master_invoice_id: Mapped[Optional[int]] = mapped_column(Integer)
    is_master_invoice: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    payment_mode: Mapped[Optional[str]] = mapped_column(Text)
    patient_mobile: Mapped[Optional[str]] = mapped_column(Text)
    patient_age: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    patient_address: Mapped[Optional[str]] = mapped_column(Text)


class LabCategories(Base):
    __tablename__ = 'lab_categories'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='lab_categories_pkey'),
        UniqueConstraint('category_type', 'category_name', name='lab_categories_category_type_category_name_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    category_type: Mapped[str] = mapped_column(Text, nullable=False)
    category_name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class LabVendors(Base):
    __tablename__ = 'lab_vendors'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='lab_vendors_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    vendor_name: Mapped[str] = mapped_column(Text, nullable=False)
    contact_person: Mapped[Optional[str]] = mapped_column(Text)
    phone: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'active'::text"))


class LeaveRequests(Base):
    __tablename__ = 'leave_requests'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])", name='leave_requests_status_check'),
        PrimaryKeyConstraint('id', name='leave_requests_pkey'),
        Index('idx_leaves_employee', 'employee_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(Text, nullable=False)
    leave_type: Mapped[str] = mapped_column(Text, nullable=False)
    start_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    end_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    reason: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'pending'::text"))
    decided_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class MedicationSchedules(Base):
    __tablename__ = 'medication_schedules'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='medication_schedules_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    schedule_time: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False)
    dosage: Mapped[Optional[str]] = mapped_column(Text)
    administered: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    alert_enabled: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('1'))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class Medicines(Base):
    __tablename__ = 'medicines'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='medicines_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    active: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('1'))
    generic_name: Mapped[Optional[str]] = mapped_column(Text)
    category: Mapped[Optional[str]] = mapped_column(Text)
    dosage_form: Mapped[Optional[str]] = mapped_column(Text)
    strength: Mapped[Optional[str]] = mapped_column(Text)
    unit: Mapped[Optional[str]] = mapped_column(Text)
    hsn_code: Mapped[Optional[str]] = mapped_column(Text)
    gst_rate: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    manufacturer: Mapped[Optional[str]] = mapped_column(Text)
    reorder_level: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('10'))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class NurseAttendance(Base):
    __tablename__ = 'nurse_attendance'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='nurse_attendance_pkey'),
        Index('idx_nurse_att_emp', 'employee_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    nurse_id: Mapped[Optional[str]] = mapped_column(Text)
    employee_id: Mapped[Optional[str]] = mapped_column(Text)
    nurse_name: Mapped[Optional[str]] = mapped_column(Text)
    department: Mapped[Optional[str]] = mapped_column(Text)
    shift: Mapped[Optional[str]] = mapped_column(Text)
    login_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    logout_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    break_time: Mapped[Optional[int]] = mapped_column(Integer)
    working_hours: Mapped[Optional[float]] = mapped_column(Double(53))
    attendance_status: Mapped[Optional[str]] = mapped_column(Text)
    device_ip: Mapped[Optional[str]] = mapped_column(Text)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class NurseMedicationAdministration(Base):
    __tablename__ = 'nurse_medication_administration'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='nurse_medication_administration_pkey'),
        Index('idx_nurse_mar_pat', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    medicine_name: Mapped[Optional[str]] = mapped_column(Text)
    strength: Mapped[Optional[str]] = mapped_column(Text)
    dose: Mapped[Optional[str]] = mapped_column(Text)
    route: Mapped[Optional[str]] = mapped_column(Text)
    frequency: Mapped[Optional[str]] = mapped_column(Text)
    scheduled_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    administered_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    nurse_name: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class NursePerformance(Base):
    __tablename__ = 'nurse_performance'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='nurse_performance_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    nurse_name: Mapped[Optional[str]] = mapped_column(Text)
    employee_id: Mapped[Optional[str]] = mapped_column(Text)
    attendance_pct: Mapped[Optional[float]] = mapped_column(Double(53))
    patients_handled: Mapped[Optional[int]] = mapped_column(Integer)
    critical_cases: Mapped[Optional[int]] = mapped_column(Integer)
    tasks_completed: Mapped[Optional[int]] = mapped_column(Integer)
    avg_response_time_min: Mapped[Optional[float]] = mapped_column(Double(53))
    medication_compliance_pct: Mapped[Optional[float]] = mapped_column(Double(53))
    shift_completion_pct: Mapped[Optional[float]] = mapped_column(Double(53))
    feedback_score: Mapped[Optional[float]] = mapped_column(Double(53))
    evaluation_period: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class NursingCareLogs(Base):
    __tablename__ = 'nursing_care_logs'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='nursing_care_logs_pkey'),
        Index('idx_nurse_care_pat', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    nurse_name: Mapped[Optional[str]] = mapped_column(Text)
    log_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    log_time: Mapped[Optional[str]] = mapped_column(Text)
    activity: Mapped[Optional[str]] = mapped_column(Text)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text)
    signature: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)


class NursingTasks(Base):
    __tablename__ = 'nursing_tasks'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='nursing_tasks_pkey'),
        Index('idx_nurse_tasks_pat', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    task_name: Mapped[Optional[str]] = mapped_column(Text)
    task_type: Mapped[Optional[str]] = mapped_column(Text)
    assigned_nurse: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text)
    due_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    completed_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class ObservationNotes(Base):
    __tablename__ = 'observation_notes'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='observation_notes_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    doctor_name: Mapped[Optional[str]] = mapped_column(Text)
    treatment_plan: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class OcrLogs(Base):
    __tablename__ = 'ocr_logs'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='ocr_logs_pkey'),
        Index('idx_ocr_logs_document', 'document_id', 'created_at')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    document_id: Mapped[Optional[int]] = mapped_column(Integer)
    user_name: Mapped[Optional[str]] = mapped_column(Text)
    module_name: Mapped[Optional[str]] = mapped_column(Text)
    error_details: Mapped[Optional[str]] = mapped_column(Text)
    processing_ms: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class OcrResults(Base):
    __tablename__ = 'ocr_results'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='ocr_results_pkey'),
        Index('idx_ocr_results_document', 'document_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(Integer, nullable=False)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    ocr_text: Mapped[Optional[str]] = mapped_column(Text)
    extracted_json: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'{}'::text"))
    language: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'en'::text"))
    confidence: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    engine: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'central_ocr'::text"))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class OtSurgeries(Base):
    __tablename__ = 'ot_surgeries'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['scheduled'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text])", name='ot_surgeries_status_check'),
        PrimaryKeyConstraint('id', name='ot_surgeries_pkey'),
        Index('idx_ot_surgeries_status', 'status'),
        Index('idx_ot_surgeries_theatre', 'theatre_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    theatre_id: Mapped[int] = mapped_column(Integer, nullable=False)
    procedure_name: Mapped[str] = mapped_column(Text, nullable=False)
    surgeon_name: Mapped[str] = mapped_column(Text, nullable=False)
    scheduled_start: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'scheduled'::text"))
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    estimated_duration_hours: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('1'))
    equipment_required: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class OtTheatres(Base):
    __tablename__ = 'ot_theatres'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['available'::text, 'maintenance'::text, 'occupied'::text])", name='ot_theatres_status_check'),
        PrimaryKeyConstraint('id', name='ot_theatres_pkey'),
        UniqueConstraint('theatre_code', name='ot_theatres_theatre_code_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    theatre_code: Mapped[str] = mapped_column(Text, nullable=False)
    theatre_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'available'::text"))
    equipment_notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class PatientAssignments(Base):
    __tablename__ = 'patient_assignments'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='patient_assignments_pkey'),
        Index('idx_nurse_assign_pat', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    ward: Mapped[Optional[str]] = mapped_column(Text)
    room: Mapped[Optional[str]] = mapped_column(Text)
    bed: Mapped[Optional[str]] = mapped_column(Text)
    assigned_nurse: Mapped[Optional[str]] = mapped_column(Text)
    department: Mapped[Optional[str]] = mapped_column(Text)
    priority: Mapped[Optional[str]] = mapped_column(Text)
    admission_date: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    shift: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class PatientConsents(Base):
    __tablename__ = 'patient_consents'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='patient_consents_pkey'),
        Index('idx_patient_consents_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_name: Mapped[str] = mapped_column(Text, nullable=False)
    consent_type: Mapped[str] = mapped_column(Text, nullable=False)
    signed_by: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'signed'::text"))
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    relation_to_patient: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    signed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class PatientJourneyEvents(Base):
    __tablename__ = 'patient_journey_events'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='patient_journey_events_pkey'),
        Index('idx_patient_journey_bed_grid', 'patient_id', 'event_time'),
        Index('idx_patient_journey_patient', 'patient_id', 'event_time')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[Optional[str]] = mapped_column(Text)
    module: Mapped[Optional[str]] = mapped_column(Text)
    reference_id: Mapped[Optional[str]] = mapped_column(Text)
    responsible_user: Mapped[Optional[str]] = mapped_column(Text)
    event_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    metadata_json: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'{}'::text"))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class PatientMovements(Base):
    __tablename__ = 'patient_movements'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='patient_movements_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    to_department: Mapped[str] = mapped_column(Text, nullable=False)
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    from_department: Mapped[Optional[str]] = mapped_column(Text)
    moved_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    moved_by: Mapped[Optional[str]] = mapped_column(Text)


class PatientVitals(Base):
    __tablename__ = 'patient_vitals'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='patient_vitals_pkey'),
        Index('idx_nurse_vitals_pat', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    record_time: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    bp: Mapped[Optional[str]] = mapped_column(Text)
    pulse: Mapped[Optional[int]] = mapped_column(Integer)
    temperature: Mapped[Optional[float]] = mapped_column(Double(53))
    respiratory_rate: Mapped[Optional[int]] = mapped_column(Integer)
    oxygen_saturation: Mapped[Optional[int]] = mapped_column(Integer)
    blood_sugar: Mapped[Optional[int]] = mapped_column(Integer)
    weight: Mapped[Optional[float]] = mapped_column(Double(53))
    height: Mapped[Optional[float]] = mapped_column(Double(53))
    pain_score: Mapped[Optional[int]] = mapped_column(Integer)
    gcs: Mapped[Optional[int]] = mapped_column(Integer)
    recorded_by: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    spo2: Mapped[Optional[float]] = mapped_column(REAL)
    recorded_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    encounter_id: Mapped[Optional[int]] = mapped_column(Integer)
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)


class PatientWorkflows(Base):
    __tablename__ = 'patient_workflows'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='patient_workflows_pkey'),
        UniqueConstraint('patient_id', name='patient_workflows_patient_id_key'),
        Index('idx_patient_workflows_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'Registered'::text"))
    current_stage: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'Registered'::text"))
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    closed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)


class Patients(Base):
    __tablename__ = 'patients'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='patients_pkey'),
        UniqueConstraint('patient_id', name='patients_patient_id_key'),
        Index('idx_patient_id', 'patient_id'),
        Index('idx_patient_name', 'name', 'last_name'),
        Index('idx_patient_phone', 'phone'),
        Index('idx_patients_bed_grid_hospital', 'hospital_id', 'patient_id'),
        Index('idx_patients_created_at', 'created_at'),
        Index('idx_patients_family_mobile', 'family_mobile')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    last_name: Mapped[str] = mapped_column(Text, nullable=False)
    middle_name: Mapped[Optional[str]] = mapped_column(Text)
    dob: Mapped[Optional[datetime.date]] = mapped_column(Date)
    age: Mapped[Optional[int]] = mapped_column(Integer)
    weight: Mapped[Optional[float]] = mapped_column(Double(53))
    height: Mapped[Optional[float]] = mapped_column(Double(53))
    gender: Mapped[Optional[str]] = mapped_column(Text)
    pregnant: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    allergies: Mapped[Optional[str]] = mapped_column(Text)
    symptoms: Mapped[Optional[str]] = mapped_column(Text)
    phone: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    address: Mapped[Optional[str]] = mapped_column(Text)
    emergency_contact: Mapped[Optional[str]] = mapped_column(Text)
    emergency_relation: Mapped[Optional[str]] = mapped_column(Text)
    family_mobile: Mapped[Optional[str]] = mapped_column(Text)
    marital_status: Mapped[Optional[str]] = mapped_column(Text)
    nationality: Mapped[Optional[str]] = mapped_column(Text)
    email: Mapped[Optional[str]] = mapped_column(Text)
    emergency_mobile: Mapped[Optional[str]] = mapped_column(Text)
    medical_history: Mapped[Optional[str]] = mapped_column(Text)
    current_medication: Mapped[Optional[str]] = mapped_column(Text)
    blood_group: Mapped[Optional[str]] = mapped_column(Text)
    allergy_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'not_recorded'::text"))
    insurance_provider: Mapped[Optional[str]] = mapped_column(Text)
    insurance_policy_no: Mapped[Optional[str]] = mapped_column(Text)
    insurance_verified: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('false'))
    insurance_verified_by: Mapped[Optional[str]] = mapped_column(Text)
    insurance_verified_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    insurance_verification_ref: Mapped[Optional[str]] = mapped_column(Text)

    admissions: Mapped[list['Admissions']] = relationship('Admissions', back_populates='patient')
    documents: Mapped[list['Documents']] = relationship('Documents', back_populates='patient')


class Payroll(Base):
    __tablename__ = 'payroll'
    __table_args__ = (
        CheckConstraint("paid_status = ANY (ARRAY['pending'::text, 'paid'::text])", name='payroll_paid_status_check'),
        PrimaryKeyConstraint('id', name='payroll_pkey'),
        Index('idx_payroll_employee', 'employee_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(Text, nullable=False)
    payroll_month: Mapped[str] = mapped_column(Text, nullable=False)
    basic_salary: Mapped[float] = mapped_column(Double(53), nullable=False)
    net_salary: Mapped[float] = mapped_column(Double(53), nullable=False)
    allowances: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    deductions: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    paid_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'pending'::text"))
    paid_date: Mapped[Optional[datetime.date]] = mapped_column(Date)


class PharmacyDispense(Base):
    __tablename__ = 'pharmacy_dispense'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='pharmacy_dispense_pkey'),
        Index('idx_pharmacy_dispense_rx', 'prescription_id', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'completed'::text"))
    prescription_id: Mapped[Optional[int]] = mapped_column(Integer)
    prescription_no: Mapped[Optional[str]] = mapped_column(Text)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    invoice_id: Mapped[Optional[int]] = mapped_column(Integer)
    total_amount: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    pharmacy_dispense_items: Mapped[list['PharmacyDispenseItems']] = relationship('PharmacyDispenseItems', back_populates='dispense')


class PharmacyDispenseTransactions(Base):
    __tablename__ = 'pharmacy_dispense_transactions'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='pharmacy_dispense_transactions_pkey'),
        Index('idx_pharmacy_dispense_txn_key', 'idempotency_key', unique=True)
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    payload_hash: Mapped[str] = mapped_column(Text, nullable=False)
    result_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class PharmacyInventory(Base):
    __tablename__ = 'pharmacy_inventory'
    __table_args__ = (
        CheckConstraint("batch_status = ANY (ARRAY['available'::text, 'quarantine'::text, 'recalled'::text])", name='pharmacy_inventory_batch_status_check'),
        CheckConstraint("stock_condition = ANY (ARRAY['proper'::text, 'damaged'::text])", name='pharmacy_inventory_stock_condition_check'),
        CheckConstraint("stock_source = ANY (ARRAY['CASH'::text, 'INSURANCE'::text, 'UNVERIFIED'::text])", name='pharmacy_inventory_stock_source_check'),
        PrimaryKeyConstraint('id', name='pharmacy_inventory_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[float] = mapped_column(Double(53), nullable=False, server_default=text('0'))
    qty_available: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    qty_damaged: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    qty_quarantine: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    batch_no: Mapped[Optional[str]] = mapped_column(Text)
    reorder_level: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('10'))
    unit_price: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    expiry_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    stock_condition: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'proper'::text"))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    product_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'Available'::text"))
    total_strips: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    strip_cost: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0.0'))
    units_per_strip: Mapped[Optional[float]] = mapped_column(Double(53), server_default=text('0'))
    item_category: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'medicine'::text"))
    medicine_id: Mapped[Optional[int]] = mapped_column(Integer)
    mfg_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    stock_source: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'UNVERIFIED'::text"))
    batch_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'available'::text"))
    purchase_price: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    mrp: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    supplier_id: Mapped[Optional[int]] = mapped_column(Integer)
    unit_type: Mapped[Optional[str]] = mapped_column(Text)


class PharmacyPurchases(Base):
    __tablename__ = 'pharmacy_purchases'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['ordered'::text, 'received'::text, 'cancelled'::text])", name='pharmacy_purchases_status_check'),
        PrimaryKeyConstraint('id', name='pharmacy_purchases_pkey'),
        Index('idx_pharmacy_purchases_supplier', 'supplier_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_cost: Mapped[float] = mapped_column(Double(53), nullable=False)
    total_cost: Mapped[float] = mapped_column(Double(53), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'ordered'::text"))
    stock_applied: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    supplier_id: Mapped[Optional[int]] = mapped_column(Integer)
    expected_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    received_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    stock_source: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'CASH'::text"))
    pr_id: Mapped[Optional[int]] = mapped_column(Integer)


class PharmacyReturns(Base):
    __tablename__ = 'pharmacy_returns'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['quarantined'::text, 'released'::text, 'rejected'::text])", name='pharmacy_returns_status_check'),
        PrimaryKeyConstraint('id', name='pharmacy_returns_pkey'),
        Index('idx_pharmacy_returns_idempotency', 'idempotency_key', postgresql_where='(idempotency_key IS NOT NULL)', unique=True)
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    original_sale_id: Mapped[int] = mapped_column(Integer, nullable=False)
    pharmacy_inventory_id: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    stock_source: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'quarantined'::text"))
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    reviewed_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    reviewed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    idempotency_key: Mapped[Optional[str]] = mapped_column(Text)


class PharmacySales(Base):
    __tablename__ = 'pharmacy_sales'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='pharmacy_sales_pkey'),
        Index('idx_pharmacy_sales_idempotency', 'idempotency_key', postgresql_where='(idempotency_key IS NOT NULL)', unique=True),
        Index('idx_pharmacy_sales_invoice', 'invoice_id'),
        Index('idx_pharmacy_sales_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price: Mapped[float] = mapped_column(Double(53), nullable=False)
    amount: Mapped[float] = mapped_column(Double(53), nullable=False)
    invoice_id: Mapped[Optional[int]] = mapped_column(Integer)
    sold_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    prescription_ref: Mapped[Optional[str]] = mapped_column(Text)
    prescription_item_id: Mapped[Optional[int]] = mapped_column(Integer)
    dispense_id: Mapped[Optional[int]] = mapped_column(Integer)
    payment_mode: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'cash'::text"))
    stock_source: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'UNVERIFIED'::text"))
    idempotency_key: Mapped[Optional[str]] = mapped_column(Text)
    transaction_id: Mapped[Optional[int]] = mapped_column(Integer)
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    indent_id: Mapped[Optional[int]] = mapped_column(Integer)
    billing_type: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'OPD_IMMEDIATE'::text"))


class PharmacySuppliers(Base):
    __tablename__ = 'pharmacy_suppliers'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['active'::text, 'inactive'::text])", name='pharmacy_suppliers_status_check'),
        PrimaryKeyConstraint('id', name='pharmacy_suppliers_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    supplier_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'::text"))
    contact_person: Mapped[Optional[str]] = mapped_column(Text)
    phone: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    gst_number: Mapped[Optional[str]] = mapped_column(Text)
    drug_license_no: Mapped[Optional[str]] = mapped_column(Text)
    address: Mapped[Optional[str]] = mapped_column(Text)
    email: Mapped[Optional[str]] = mapped_column(Text)
    payment_terms: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'30 days'::text"))


class PrescriptionMedicines(Base):
    __tablename__ = 'prescription_medicines'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='prescription_medicines_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    prescription_id: Mapped[int] = mapped_column(Integer, nullable=False)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    dosage: Mapped[Optional[str]] = mapped_column(Text)
    frequency: Mapped[Optional[str]] = mapped_column(Text)
    duration: Mapped[Optional[str]] = mapped_column(Text)
    instructions: Mapped[Optional[str]] = mapped_column(Text)
    is_custom: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    freq_custom: Mapped[Optional[str]] = mapped_column(Text)


class Prescriptions(Base):
    __tablename__ = 'prescriptions'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['pending'::text, 'dispensed'::text, 'partially_dispensed'::text, 'cancelled'::text])", name='prescriptions_status_check'),
        PrimaryKeyConstraint('id', name='prescriptions_pkey'),
        UniqueConstraint('prescription_no', name='prescriptions_prescription_no_key'),
        Index('idx_prescriptions_patient', 'patient_id'),
        Index('idx_prescriptions_patient_last4', 'patient_last4', 'created_at'),
        Index('idx_prescriptions_save_token', 'save_token')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    prescription_no: Mapped[Optional[str]] = mapped_column(Text)
    patient_last4: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    doctor_name: Mapped[Optional[str]] = mapped_column(Text)
    department: Mapped[Optional[str]] = mapped_column(Text)
    consultation_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    consultation_time: Mapped[Optional[str]] = mapped_column(Text)
    visit_type: Mapped[Optional[str]] = mapped_column(Text)
    consultation_id: Mapped[Optional[str]] = mapped_column(Text)
    diagnosis: Mapped[Optional[str]] = mapped_column(Text)
    lab_tests: Mapped[Optional[str]] = mapped_column(Text)
    advice: Mapped[Optional[str]] = mapped_column(Text)
    follow_up_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    lab_fbs: Mapped[Optional[str]] = mapped_column(Text)
    lab_ppbs: Mapped[Optional[str]] = mapped_column(Text)
    lab_hba1c: Mapped[Optional[str]] = mapped_column(Text)
    lab_tchol: Mapped[Optional[str]] = mapped_column(Text)
    lab_ldl: Mapped[Optional[str]] = mapped_column(Text)
    lab_tgl: Mapped[Optional[str]] = mapped_column(Text)
    lab_vitd: Mapped[Optional[str]] = mapped_column(Text)
    save_token: Mapped[Optional[str]] = mapped_column(Text)
    appointment_id: Mapped[Optional[int]] = mapped_column(Integer)
    dispense_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'not_sent'::text"))
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    order_type: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'OPD'::text"))
    ward: Mapped[Optional[str]] = mapped_column(Text)
    bed_no: Mapped[Optional[str]] = mapped_column(Text)
    route: Mapped[Optional[str]] = mapped_column(Text)
    priority: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'normal'::text"))

    prescription_items: Mapped[list['PrescriptionItems']] = relationship('PrescriptionItems', back_populates='prescription')


class PurchaseRequests(Base):
    __tablename__ = 'purchase_requests'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'ordered'::text])", name='purchase_requests_status_check'),
        PrimaryKeyConstraint('id', name='purchase_requests_pkey'),
        UniqueConstraint('pr_no', name='purchase_requests_pr_no_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pr_no: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    requested_by: Mapped[Optional[str]] = mapped_column(Text)
    priority: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'normal'::text"))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    approved_by: Mapped[Optional[str]] = mapped_column(Text)
    approved_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    preferred_supplier_id: Mapped[Optional[int]] = mapped_column(Integer)
    supplier_id: Mapped[Optional[int]] = mapped_column(Integer)

    purchase_request_items: Mapped[list['PurchaseRequestItems']] = relationship('PurchaseRequestItems', back_populates='pr')


class SharedExports(Base):
    __tablename__ = 'shared_exports'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='shared_exports_pkey'),
        UniqueConstraint('share_token', name='shared_exports_share_token_key'),
        Index('idx_shared_exports_token', 'share_token')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    share_token: Mapped[str] = mapped_column(Text, nullable=False)
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    file_name: Mapped[Optional[str]] = mapped_column(Text)
    mime_type: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class ShiftHandovers(Base):
    __tablename__ = 'shift_handovers'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='shift_handovers_pkey'),
        Index('idx_nurse_handover_pat', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    patient_name: Mapped[Optional[str]] = mapped_column(Text)
    handover_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    shift_from: Mapped[Optional[str]] = mapped_column(Text)
    shift_to: Mapped[Optional[str]] = mapped_column(Text)
    nurse_from: Mapped[Optional[str]] = mapped_column(Text)
    nurse_to: Mapped[Optional[str]] = mapped_column(Text)
    patient_condition: Mapped[Optional[str]] = mapped_column(Text)
    pending_medicines: Mapped[Optional[str]] = mapped_column(Text)
    pending_investigations: Mapped[Optional[str]] = mapped_column(Text)
    critical_notes: Mapped[Optional[str]] = mapped_column(Text)
    iv_fluids: Mapped[Optional[str]] = mapped_column(Text)
    oxygen_status: Mapped[Optional[str]] = mapped_column(Text)
    doctor_instructions: Mapped[Optional[str]] = mapped_column(Text)
    handover_remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class StockAdjustments(Base):
    __tablename__ = 'stock_adjustments'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='stock_adjustments_pkey'),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pharmacy_inventory_id: Mapped[int] = mapped_column(Integer, nullable=False)
    delta_qty: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    adjusted_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class StockMovements(Base):
    __tablename__ = 'stock_movements'
    __table_args__ = (
        CheckConstraint("movement_type = ANY (ARRAY['receipt'::text, 'dispense'::text, 'return_in'::text, 'return_release'::text, 'return_reject'::text, 'adjustment'::text])", name='stock_movements_movement_type_check'),
        PrimaryKeyConstraint('id', name='stock_movements_pkey'),
        Index('idx_stock_movements_batch', 'pharmacy_inventory_id'),
        Index('idx_stock_movements_source', 'stock_source')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pharmacy_inventory_id: Mapped[int] = mapped_column(Integer, nullable=False)
    stock_source: Mapped[str] = mapped_column(Text, nullable=False)
    movement_type: Mapped[str] = mapped_column(Text, nullable=False)
    delta_qty: Mapped[int] = mapped_column(Integer, nullable=False)
    ref_table: Mapped[Optional[str]] = mapped_column(Text)
    ref_id: Mapped[Optional[int]] = mapped_column(Integer)
    actor: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class Users(Base):
    __tablename__ = 'users'
    __table_args__ = (
        CheckConstraint("access_role = ANY (ARRAY['receptionist'::text, 'clinician'::text, 'hr_manager'::text, 'owner'::text])", name='users_access_role_check'),
        CheckConstraint("role = ANY (ARRAY['employee'::text, 'staff'::text])", name='users_role_check'),
        CheckConstraint("status = ANY (ARRAY['active'::text, 'inactive'::text])", name='users_status_check'),
        CheckConstraint("user_type = ANY (ARRAY['super_admin'::text, 'admin'::text, 'normal'::text])", name='users_user_type_check'),
        PrimaryKeyConstraint('id', name='users_pkey'),
        UniqueConstraint('username', name='users_username_key'),
        Index('idx_users_hospital_employee_id', 'hospital_id', 'employee_id', postgresql_where='(employee_id IS NOT NULL)', unique=True),
        Index('idx_users_hospital_username', 'hospital_id', 'username'),
        Index('idx_users_username', 'username')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    access_role: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'receptionist'::text"))
    user_type: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'normal'::text"))
    module_access: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'[]'::text"))
    job_role: Mapped[Optional[str]] = mapped_column(Text)
    full_name: Mapped[Optional[str]] = mapped_column(Text)
    email: Mapped[Optional[str]] = mapped_column(Text)
    phone: Mapped[Optional[str]] = mapped_column(Text)
    department: Mapped[Optional[str]] = mapped_column(Text)
    employee_id: Mapped[Optional[str]] = mapped_column(Text)
    date_joined: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'active'::text"))
    address: Mapped[Optional[str]] = mapped_column(Text)
    emergency_contact: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)

    sessions: Mapped[list['Sessions']] = relationship('Sessions', back_populates='user')


class VendorPayments(Base):
    __tablename__ = 'vendor_payments'
    __table_args__ = (
        CheckConstraint("payment_mode = ANY (ARRAY['cash'::text, 'card'::text, 'upi'::text, 'bank'::text, 'razorpay'::text, 'bank_transfer'::text, 'net_banking'::text, 'mixed_payment'::text, 'cheque'::text])", name='vendor_payments_payment_mode_check'),
        CheckConstraint("status = ANY (ARRAY['pending'::text, 'partial'::text, 'paid'::text])", name='vendor_payments_status_check'),
        PrimaryKeyConstraint('id', name='vendor_payments_pkey'),
        Index('idx_vendor_payments_vendor', 'vendor_name')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    vendor_name: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[float] = mapped_column(Double(53), nullable=False)
    payment_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    payment_mode: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'paid'::text"))
    invoice_ref: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class WardIndents(Base):
    __tablename__ = 'ward_indents'
    __table_args__ = (
        CheckConstraint("priority = ANY (ARRAY['normal'::text, 'urgent'::text, 'stat'::text])", name='ward_indents_priority_check'),
        CheckConstraint("status = ANY (ARRAY['pending'::text, 'processing'::text, 'dispensed'::text, 'cancelled'::text])", name='ward_indents_status_check'),
        PrimaryKeyConstraint('id', name='ward_indents_pkey'),
        UniqueConstraint('indent_no', name='ward_indents_indent_no_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    indent_no: Mapped[str] = mapped_column(Text, nullable=False)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    ward: Mapped[str] = mapped_column(Text, nullable=False)
    bed_no: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'normal'::text"))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    doctor_name: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    dispensed_by: Mapped[Optional[str]] = mapped_column(Text)
    dispensed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)

    ward_indent_items: Mapped[list['WardIndentItems']] = relationship('WardIndentItems', back_populates='indent')


class WorkflowRecords(Base):
    __tablename__ = 'workflow_records'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='workflow_records_pkey'),
        Index('idx_workflow_records_hash', 'patient_id', 'record_type', 'record_hash', unique=True),
        Index('idx_workflow_records_patient_type', 'patient_id', 'record_type')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    record_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'{}'::text"))
    record_hash: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'saved'::text"))
    created_by: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))


class Admissions(Base):
    __tablename__ = 'admissions'
    __table_args__ = (
        ForeignKeyConstraint(['patient_id'], ['patients.patient_id'], name='admissions_patient_id_fkey'),
        PrimaryKeyConstraint('id', name='admissions_pkey'),
        Index('idx_admissions_bed_grid_patient', 'patient_id', 'admission_date', 'discharge_date'),
        Index('idx_admissions_patient', 'patient_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(Text, nullable=False)
    admission_date: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False)
    discharge_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    source_encounter_id: Mapped[Optional[int]] = mapped_column(Integer)

    patient: Mapped['Patients'] = relationship('Patients', back_populates='admissions')
    documents: Mapped[list['Documents']] = relationship('Documents', back_populates='admission')


class DiagEquipmentMaintenance(Base):
    __tablename__ = 'diag_equipment_maintenance'
    __table_args__ = (
        CheckConstraint("completion_status = ANY (ARRAY['scheduled'::text, 'in_progress'::text, 'completed'::text])", name='diag_equipment_maintenance_completion_status_check'),
        ForeignKeyConstraint(['equipment_id'], ['diag_equipment.id'], name='diag_equipment_maintenance_equipment_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_equipment_maintenance_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    equipment_id: Mapped[int] = mapped_column(Integer, nullable=False)
    completion_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'completed'::text"))
    service_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    service_type: Mapped[Optional[str]] = mapped_column(Text)
    findings: Mapped[Optional[str]] = mapped_column(Text)
    work_performed: Mapped[Optional[str]] = mapped_column(Text)
    responsible: Mapped[Optional[str]] = mapped_column(Text)
    next_due_date: Mapped[Optional[datetime.date]] = mapped_column(Date)
    downtime_start: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    downtime_end: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    return_to_service_by: Mapped[Optional[str]] = mapped_column(Text)
    return_to_service_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    equipment: Mapped['DiagEquipment'] = relationship('DiagEquipment', back_populates='diag_equipment_maintenance')


class DiagOrderItems(Base):
    __tablename__ = 'diag_order_items'
    __table_args__ = (
        CheckConstraint("department_type = ANY (ARRAY['LAB'::text, 'IMAGING'::text, 'OTHER'::text])", name='diag_order_items_department_type_check'),
        ForeignKeyConstraint(['order_id'], ['diag_orders.id'], ondelete='CASCADE', name='diag_order_items_order_id_fkey'),
        ForeignKeyConstraint(['service_id'], ['diag_services.id'], name='diag_order_items_service_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_order_items_pkey'),
        Index('idx_diag_order_items_order', 'order_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[int] = mapped_column(Integer, nullable=False)
    service_id: Mapped[int] = mapped_column(Integer, nullable=False)
    service_name: Mapped[str] = mapped_column(Text, nullable=False)
    department_type: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('1'))
    rate: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text('0'))
    discount: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text('0'))
    amount: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text('0'))
    progress_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'ordered'::text"))
    is_duplicate_repeat: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('false'))
    duplicate_reason: Mapped[Optional[str]] = mapped_column(Text)
    cancelled_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    cancel_reason: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    discharge_invoice_id: Mapped[Optional[int]] = mapped_column(Integer)

    order: Mapped['DiagOrders'] = relationship('DiagOrders', back_populates='diag_order_items')
    service: Mapped['DiagServices'] = relationship('DiagServices', back_populates='diag_order_items')
    diag_critical_alerts: Mapped[list['DiagCriticalAlerts']] = relationship('DiagCriticalAlerts', back_populates='order_item')
    diag_external_referrals: Mapped[list['DiagExternalReferrals']] = relationship('DiagExternalReferrals', back_populates='order_item')
    diag_imaging_exams: Mapped[list['DiagImagingExams']] = relationship('DiagImagingExams', back_populates='order_item')
    diag_reports: Mapped[list['DiagReports']] = relationship('DiagReports', back_populates='order_item')
    diag_results: Mapped[list['DiagResults']] = relationship('DiagResults', back_populates='order_item')
    diag_specimens: Mapped[list['DiagSpecimens']] = relationship('DiagSpecimens', back_populates='order_item')


class DiagPackageItems(Base):
    __tablename__ = 'diag_package_items'
    __table_args__ = (
        ForeignKeyConstraint(['package_id'], ['diag_packages.id'], ondelete='CASCADE', name='diag_package_items_package_id_fkey'),
        ForeignKeyConstraint(['service_id'], ['diag_services.id'], ondelete='CASCADE', name='diag_package_items_service_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_package_items_pkey'),
        UniqueConstraint('package_id', 'service_id', name='diag_package_items_package_id_service_id_key')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    package_id: Mapped[int] = mapped_column(Integer, nullable=False)
    service_id: Mapped[int] = mapped_column(Integer, nullable=False)

    package: Mapped['DiagPackages'] = relationship('DiagPackages', back_populates='diag_package_items')
    service: Mapped['DiagServices'] = relationship('DiagServices', back_populates='diag_package_items')


class DiagQcRuns(Base):
    __tablename__ = 'diag_qc_runs'
    __table_args__ = (
        CheckConstraint("outcome = ANY (ARRAY['passed'::text, 'failed'::text, 'pending'::text])", name='diag_qc_runs_outcome_check'),
        ForeignKeyConstraint(['equipment_id'], ['diag_equipment.id'], name='diag_qc_runs_equipment_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_qc_runs_pkey'),
        Index('idx_diag_qc_runs_equipment', 'equipment_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    equipment_id: Mapped[int] = mapped_column(Integer, nullable=False)
    outcome: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    service_id: Mapped[Optional[int]] = mapped_column(Integer)
    control_material: Mapped[Optional[str]] = mapped_column(Text)
    control_lot: Mapped[Optional[str]] = mapped_column(Text)
    run_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    operator: Mapped[Optional[str]] = mapped_column(Text)
    measurements: Mapped[Optional[str]] = mapped_column(Text)
    reviewed_by: Mapped[Optional[str]] = mapped_column(Text)
    reviewed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    notes: Mapped[Optional[str]] = mapped_column(Text)

    equipment: Mapped['DiagEquipment'] = relationship('DiagEquipment', back_populates='diag_qc_runs')
    diag_qc_holds: Mapped[list['DiagQcHolds']] = relationship('DiagQcHolds', back_populates='qc_run')


class DiagServiceParameters(Base):
    __tablename__ = 'diag_service_parameters'
    __table_args__ = (
        CheckConstraint("data_type = ANY (ARRAY['numeric'::text, 'text'::text, 'qualitative'::text])", name='diag_service_parameters_data_type_check'),
        CheckConstraint("sex_specific IS NULL OR (sex_specific = ANY (ARRAY['M'::text, 'F'::text]))", name='diag_service_parameters_sex_specific_check'),
        ForeignKeyConstraint(['service_id'], ['diag_services.id'], ondelete='CASCADE', name='diag_service_parameters_service_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_service_parameters_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    service_id: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    data_type: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'numeric'::text"))
    unit: Mapped[Optional[str]] = mapped_column(Text)
    method: Mapped[Optional[str]] = mapped_column(Text)
    ref_low: Mapped[Optional[float]] = mapped_column(REAL)
    ref_high: Mapped[Optional[float]] = mapped_column(REAL)
    ref_text: Mapped[Optional[str]] = mapped_column(Text)
    critical_low: Mapped[Optional[float]] = mapped_column(REAL)
    critical_high: Mapped[Optional[float]] = mapped_column(REAL)
    sex_specific: Mapped[Optional[str]] = mapped_column(Text)
    age_min: Mapped[Optional[int]] = mapped_column(Integer)
    age_max: Mapped[Optional[int]] = mapped_column(Integer)
    display_order: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    calc_formula: Mapped[Optional[str]] = mapped_column(Text)
    comments: Mapped[Optional[str]] = mapped_column(Text)

    service: Mapped['DiagServices'] = relationship('DiagServices', back_populates='diag_service_parameters')


class DiagServicePricingHistory(Base):
    __tablename__ = 'diag_service_pricing_history'
    __table_args__ = (
        ForeignKeyConstraint(['service_id'], ['diag_services.id'], ondelete='CASCADE', name='diag_service_pricing_history_service_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_service_pricing_history_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    service_id: Mapped[int] = mapped_column(Integer, nullable=False)
    rate: Mapped[float] = mapped_column(REAL, nullable=False)
    payer_type: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'standard'::text"))
    effective_from: Mapped[Optional[datetime.date]] = mapped_column(Date, server_default=text('CURRENT_DATE'))
    changed_by: Mapped[Optional[str]] = mapped_column(Text)
    changed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    service: Mapped['DiagServices'] = relationship('DiagServices', back_populates='diag_service_pricing_history')


class DiagStockMovements(Base):
    __tablename__ = 'diag_stock_movements'
    __table_args__ = (
        CheckConstraint("movement_type = ANY (ARRAY['receipt'::text, 'consume'::text, 'adjustment'::text, 'quarantine'::text, 'release'::text])", name='diag_stock_movements_movement_type_check'),
        ForeignKeyConstraint(['reagent_lot_id'], ['diag_reagent_lots.id'], name='diag_stock_movements_reagent_lot_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_stock_movements_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    reagent_lot_id: Mapped[int] = mapped_column(Integer, nullable=False)
    movement_type: Mapped[str] = mapped_column(Text, nullable=False)
    delta_qty: Mapped[float] = mapped_column(REAL, nullable=False)
    actor: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    notes: Mapped[Optional[str]] = mapped_column(Text)

    reagent_lot: Mapped['DiagReagentLots'] = relationship('DiagReagentLots', back_populates='diag_stock_movements')


class DiagnosticPayments(Base):
    __tablename__ = 'diagnostic_payments'
    __table_args__ = (
        CheckConstraint("payment_mode = ANY (ARRAY['cash'::text, 'card'::text, 'upi'::text, 'bank'::text, 'razorpay'::text])", name='diagnostic_payments_payment_mode_check'),
        ForeignKeyConstraint(['diagnostic_id'], ['diagnostics.id'], ondelete='CASCADE', name='diagnostic_payments_diagnostic_id_fkey'),
        PrimaryKeyConstraint('id', name='diagnostic_payments_pkey'),
        Index('idx_diagnostic_payments_diagnostic', 'diagnostic_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    diagnostic_id: Mapped[int] = mapped_column(Integer, nullable=False)
    payment_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    payment_amount: Mapped[float] = mapped_column(REAL, nullable=False)
    payment_mode: Mapped[str] = mapped_column(Text, nullable=False)
    transaction_ref: Mapped[Optional[str]] = mapped_column(Text)
    operator_name: Mapped[Optional[str]] = mapped_column(Text)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    diagnostic: Mapped['Diagnostics'] = relationship('Diagnostics', back_populates='diagnostic_payments')


class DoctorPayoutPayments(Base):
    __tablename__ = 'doctor_payout_payments'
    __table_args__ = (
        ForeignKeyConstraint(['payout_id'], ['doctor_payouts.id'], ondelete='CASCADE', name='doctor_payout_payments_payout_id_fkey'),
        PrimaryKeyConstraint('id', name='doctor_payout_payments_pkey'),
        Index('idx_doctor_payout_payments_payout', 'payout_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    payout_id: Mapped[int] = mapped_column(Integer, nullable=False)
    amount: Mapped[float] = mapped_column(REAL, nullable=False)
    paid_date: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    notes: Mapped[Optional[str]] = mapped_column(Text)

    payout: Mapped['DoctorPayouts'] = relationship('DoctorPayouts', back_populates='doctor_payout_payments')


class PharmacyDispenseItems(Base):
    __tablename__ = 'pharmacy_dispense_items'
    __table_args__ = (
        ForeignKeyConstraint(['dispense_id'], ['pharmacy_dispense.id'], ondelete='CASCADE', name='pharmacy_dispense_items_dispense_id_fkey'),
        PrimaryKeyConstraint('id', name='pharmacy_dispense_items_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dispense_id: Mapped[int] = mapped_column(Integer, nullable=False)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text('0'))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'dispensed'::text"))
    prescription_item_id: Mapped[Optional[int]] = mapped_column(Integer)
    batch_no: Mapped[Optional[str]] = mapped_column(Text)
    unit_price: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    amount: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    balance_quantity: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    dispense: Mapped['PharmacyDispense'] = relationship('PharmacyDispense', back_populates='pharmacy_dispense_items')


class PrescriptionItems(Base):
    __tablename__ = 'prescription_items'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['pending'::text, 'dispensed'::text, 'partially_dispensed'::text, 'cancelled'::text])", name='prescription_items_status_check'),
        ForeignKeyConstraint(['prescription_id'], ['prescriptions.id'], ondelete='CASCADE', name='prescription_items_prescription_id_fkey'),
        PrimaryKeyConstraint('id', name='prescription_items_pkey'),
        Index('idx_prescription_items_rx', 'prescription_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    prescription_id: Mapped[int] = mapped_column(Integer, nullable=False)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text('1'))
    quantity_dispensed: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text('0'))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    strength: Mapped[Optional[str]] = mapped_column(Text)
    dosage: Mapped[Optional[str]] = mapped_column(Text)
    frequency: Mapped[Optional[str]] = mapped_column(Text)
    route: Mapped[Optional[str]] = mapped_column(Text)
    duration: Mapped[Optional[str]] = mapped_column(Text)
    food_timing: Mapped[Optional[str]] = mapped_column(Text)
    morning: Mapped[Optional[str]] = mapped_column(Text)
    afternoon: Mapped[Optional[str]] = mapped_column(Text)
    night: Mapped[Optional[str]] = mapped_column(Text)
    instructions: Mapped[Optional[str]] = mapped_column(Text)
    generic_brand_name: Mapped[Optional[str]] = mapped_column(Text)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    prescription: Mapped['Prescriptions'] = relationship('Prescriptions', back_populates='prescription_items')


class PurchaseRequestItems(Base):
    __tablename__ = 'purchase_request_items'
    __table_args__ = (
        ForeignKeyConstraint(['pr_id'], ['purchase_requests.id'], ondelete='CASCADE', name='purchase_request_items_pr_id_fkey'),
        PrimaryKeyConstraint('id', name='purchase_request_items_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pr_id: Mapped[int] = mapped_column(Integer, nullable=False)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    required_qty: Mapped[int] = mapped_column(Integer, nullable=False)
    medicine_id: Mapped[Optional[int]] = mapped_column(Integer)
    current_stock: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    min_level: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('10'))
    estimated_unit_cost: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    notes: Mapped[Optional[str]] = mapped_column(Text)

    pr: Mapped['PurchaseRequests'] = relationship('PurchaseRequests', back_populates='purchase_request_items')


class Sessions(Base):
    __tablename__ = 'sessions'
    __table_args__ = (
        ForeignKeyConstraint(['user_id'], ['users.id'], name='sessions_user_id_fkey'),
        PrimaryKeyConstraint('id', name='sessions_pkey'),
        UniqueConstraint('token_hash', name='sessions_token_hash_key'),
        Index('idx_sessions_expires', 'expires_at'),
        Index('idx_sessions_token', 'token_hash'),
        Index('idx_sessions_user', 'user_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    last_seen: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    ip_address: Mapped[Optional[str]] = mapped_column(Text)
    user_agent: Mapped[Optional[str]] = mapped_column(Text)
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)

    user: Mapped['Users'] = relationship('Users', back_populates='sessions')


class WardIndentItems(Base):
    __tablename__ = 'ward_indent_items'
    __table_args__ = (
        ForeignKeyConstraint(['indent_id'], ['ward_indents.id'], ondelete='CASCADE', name='ward_indent_items_indent_id_fkey'),
        PrimaryKeyConstraint('id', name='ward_indent_items_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    indent_id: Mapped[int] = mapped_column(Integer, nullable=False)
    medicine_name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity_ordered: Mapped[int] = mapped_column(Integer, nullable=False)
    medicine_id: Mapped[Optional[int]] = mapped_column(Integer)
    dose: Mapped[Optional[str]] = mapped_column(Text)
    frequency: Mapped[Optional[str]] = mapped_column(Text)
    route: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'Oral'::text"))
    quantity_dispensed: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'pending'::text"))
    start_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    end_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    is_prn: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('false'))
    instructions: Mapped[Optional[str]] = mapped_column(Text)
    cancelled_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    cancel_reason: Mapped[Optional[str]] = mapped_column(Text)
    ordered_by: Mapped[Optional[str]] = mapped_column(Text)

    indent: Mapped['WardIndents'] = relationship('WardIndents', back_populates='ward_indent_items')


class DiagCriticalAlerts(Base):
    __tablename__ = 'diag_critical_alerts'
    __table_args__ = (
        CheckConstraint("ack_method IS NULL OR (ack_method = ANY (ARRAY['verbal_readback'::text, 'written'::text, 'callback'::text]))", name='diag_critical_alerts_ack_method_check'),
        ForeignKeyConstraint(['order_item_id'], ['diag_order_items.id'], ondelete='CASCADE', name='diag_critical_alerts_order_item_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_critical_alerts_pkey'),
        Index('idx_diag_critical_open', 'resolved_at')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_item_id: Mapped[int] = mapped_column(Integer, nullable=False)
    result_id: Mapped[Optional[int]] = mapped_column(Integer)
    report_id: Mapped[Optional[int]] = mapped_column(Integer)
    raised_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    contacted_person: Mapped[Optional[str]] = mapped_column(Text)
    contacted_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    contacted_by: Mapped[Optional[str]] = mapped_column(Text)
    ack_method: Mapped[Optional[str]] = mapped_column(Text)
    ack_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    escalated: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('false'))
    escalated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    escalated_to: Mapped[Optional[str]] = mapped_column(Text)
    resolved_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    notes: Mapped[Optional[str]] = mapped_column(Text)

    order_item: Mapped['DiagOrderItems'] = relationship('DiagOrderItems', back_populates='diag_critical_alerts')


class DiagExternalReferrals(Base):
    __tablename__ = 'diag_external_referrals'
    __table_args__ = (
        CheckConstraint("local_review_status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'released'::text])", name='diag_external_referrals_local_review_status_check'),
        ForeignKeyConstraint(['order_item_id'], ['diag_order_items.id'], ondelete='CASCADE', name='diag_external_referrals_order_item_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_external_referrals_pkey')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_item_id: Mapped[int] = mapped_column(Integer, nullable=False)
    local_review_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'::text"))
    vendor_id: Mapped[Optional[int]] = mapped_column(Integer)
    dispatched_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    dispatched_by: Mapped[Optional[str]] = mapped_column(Text)
    expected_turnaround: Mapped[Optional[str]] = mapped_column(Text)
    received_report_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    report_document_id: Mapped[Optional[int]] = mapped_column(Integer)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    order_item: Mapped['DiagOrderItems'] = relationship('DiagOrderItems', back_populates='diag_external_referrals')


class DiagImagingExams(Base):
    __tablename__ = 'diag_imaging_exams'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['scheduled'::text, 'arrived'::text, 'prep'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text, 'no_show'::text])", name='diag_imaging_exams_status_check'),
        ForeignKeyConstraint(['order_item_id'], ['diag_order_items.id'], ondelete='CASCADE', name='diag_imaging_exams_order_item_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_imaging_exams_pkey'),
        Index('idx_diag_imaging_item', 'order_item_id'),
        Index('idx_diag_imaging_scheduled', 'scheduled_at')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_item_id: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'scheduled'::text"))
    modality: Mapped[Optional[str]] = mapped_column(Text)
    room: Mapped[Optional[str]] = mapped_column(Text)
    scheduled_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    expected_duration_min: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('30'))
    assigned_staff: Mapped[Optional[str]] = mapped_column(Text)
    prep_instructions: Mapped[Optional[str]] = mapped_column(Text)
    arrived_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    prep_completed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    consent_recorded: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('false'))
    consent_notes: Mapped[Optional[str]] = mapped_column(Text)
    started_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    completed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    performing_staff: Mapped[Optional[str]] = mapped_column(Text)
    image_available: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('false'))
    reschedule_reason: Mapped[Optional[str]] = mapped_column(Text)
    cancel_reason: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    no_show_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)

    order_item: Mapped['DiagOrderItems'] = relationship('DiagOrderItems', back_populates='diag_imaging_exams')


class DiagQcHolds(Base):
    __tablename__ = 'diag_qc_holds'
    __table_args__ = (
        CheckConstraint("scope = ANY (ARRAY['equipment'::text, 'assay'::text])", name='diag_qc_holds_scope_check'),
        CheckConstraint("status = ANY (ARRAY['open'::text, 'investigating'::text, 'corrective_action_recorded'::text, 'repeat_qc_pending'::text, 'released'::text])", name='diag_qc_holds_status_check'),
        ForeignKeyConstraint(['equipment_id'], ['diag_equipment.id'], name='diag_qc_holds_equipment_id_fkey'),
        ForeignKeyConstraint(['qc_run_id'], ['diag_qc_runs.id'], name='diag_qc_holds_qc_run_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_qc_holds_pkey'),
        Index('idx_diag_qc_holds_status', 'status')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    qc_run_id: Mapped[int] = mapped_column(Integer, nullable=False)
    equipment_id: Mapped[int] = mapped_column(Integer, nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'open'::text"))
    service_id: Mapped[Optional[int]] = mapped_column(Integer)
    corrective_action: Mapped[Optional[str]] = mapped_column(Text)
    assigned_to: Mapped[Optional[str]] = mapped_column(Text)
    repeat_qc_run_id: Mapped[Optional[int]] = mapped_column(Integer)
    released_by: Mapped[Optional[str]] = mapped_column(Text)
    released_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    release_notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    equipment: Mapped['DiagEquipment'] = relationship('DiagEquipment', back_populates='diag_qc_holds')
    qc_run: Mapped['DiagQcRuns'] = relationship('DiagQcRuns', back_populates='diag_qc_holds')


class DiagReports(Base):
    __tablename__ = 'diag_reports'
    __table_args__ = (
        CheckConstraint("report_type = ANY (ARRAY['LAB'::text, 'IMAGING'::text])", name='diag_reports_report_type_check'),
        CheckConstraint("status = ANY (ARRAY['draft'::text, 'pending_review'::text, 'returned_for_correction'::text, 'authorized'::text, 'released'::text, 'amended'::text])", name='diag_reports_status_check'),
        ForeignKeyConstraint(['order_item_id'], ['diag_order_items.id'], ondelete='CASCADE', name='diag_reports_order_item_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_reports_pkey'),
        Index('idx_diag_reports_item', 'order_item_id'),
        Index('idx_diag_reports_status', 'status')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_item_id: Mapped[int] = mapped_column(Integer, nullable=False)
    report_type: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('1'))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'draft'::text"))
    is_preliminary: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('false'))
    content: Mapped[Optional[str]] = mapped_column(Text)
    template: Mapped[Optional[str]] = mapped_column(Text)
    drafted_by: Mapped[Optional[str]] = mapped_column(Text)
    drafted_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    submitted_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    reviewed_by: Mapped[Optional[str]] = mapped_column(Text)
    return_reason: Mapped[Optional[str]] = mapped_column(Text)
    returned_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    authorized_by: Mapped[Optional[str]] = mapped_column(Text)
    authorized_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    released_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    previous_version_id: Mapped[Optional[int]] = mapped_column(Integer)
    amendment_reason: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    order_item: Mapped['DiagOrderItems'] = relationship('DiagOrderItems', back_populates='diag_reports')


class DiagResults(Base):
    __tablename__ = 'diag_results'
    __table_args__ = (
        CheckConstraint("flag IS NULL OR (flag = ANY (ARRAY['normal'::text, 'high'::text, 'low'::text, 'critical_high'::text, 'critical_low'::text, 'abnormal'::text]))", name='diag_results_flag_check'),
        ForeignKeyConstraint(['order_item_id'], ['diag_order_items.id'], ondelete='CASCADE', name='diag_results_order_item_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_results_pkey'),
        Index('idx_diag_results_item', 'order_item_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_item_id: Mapped[int] = mapped_column(Integer, nullable=False)
    parameter_name: Mapped[str] = mapped_column(Text, nullable=False)
    specimen_id: Mapped[Optional[int]] = mapped_column(Integer)
    parameter_id: Mapped[Optional[int]] = mapped_column(Integer)
    equipment_id: Mapped[Optional[int]] = mapped_column(Integer)
    value_text: Mapped[Optional[str]] = mapped_column(Text)
    value_numeric: Mapped[Optional[float]] = mapped_column(REAL)
    unit: Mapped[Optional[str]] = mapped_column(Text)
    method: Mapped[Optional[str]] = mapped_column(Text)
    ref_range_text: Mapped[Optional[str]] = mapped_column(Text)
    ref_low: Mapped[Optional[float]] = mapped_column(REAL)
    ref_high: Mapped[Optional[float]] = mapped_column(REAL)
    flag: Mapped[Optional[str]] = mapped_column(Text)
    is_draft: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('true'))
    entered_by: Mapped[Optional[str]] = mapped_column(Text)
    entered_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    updated_by: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)

    order_item: Mapped['DiagOrderItems'] = relationship('DiagOrderItems', back_populates='diag_results')


class DiagSpecimens(Base):
    __tablename__ = 'diag_specimens'
    __table_args__ = (
        CheckConstraint("status = ANY (ARRAY['awaiting_collection'::text, 'collected'::text, 'received'::text, 'rejected'::text])", name='diag_specimens_status_check'),
        ForeignKeyConstraint(['order_item_id'], ['diag_order_items.id'], ondelete='CASCADE', name='diag_specimens_order_item_id_fkey'),
        PrimaryKeyConstraint('id', name='diag_specimens_pkey'),
        UniqueConstraint('specimen_no', name='diag_specimens_specimen_no_key'),
        Index('idx_diag_specimens_item', 'order_item_id')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_item_id: Mapped[int] = mapped_column(Integer, nullable=False)
    specimen_no: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'awaiting_collection'::text"))
    container_type: Mapped[Optional[str]] = mapped_column(Text)
    collection_location: Mapped[Optional[str]] = mapped_column(Text)
    identity_verified: Mapped[Optional[bool]] = mapped_column(Boolean, server_default=text('false'))
    collected_by: Mapped[Optional[str]] = mapped_column(Text)
    collected_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    collection_notes: Mapped[Optional[str]] = mapped_column(Text)
    received_by: Mapped[Optional[str]] = mapped_column(Text)
    received_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    condition_on_receipt: Mapped[Optional[str]] = mapped_column(Text)
    rejection_reason: Mapped[Optional[str]] = mapped_column(Text)
    replaces_specimen_id: Mapped[Optional[int]] = mapped_column(Integer)
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    order_item: Mapped['DiagOrderItems'] = relationship('DiagOrderItems', back_populates='diag_specimens')


class Documents(Base):
    __tablename__ = 'documents'
    __table_args__ = (
        ForeignKeyConstraint(['admission_id'], ['admissions.id'], name='documents_admission_id_fkey'),
        ForeignKeyConstraint(['patient_id'], ['patients.patient_id'], name='documents_patient_id_fkey'),
        PrimaryKeyConstraint('id', name='documents_pkey'),
        Index('idx_documents_hash', 'hospital_id', 'file_hash'),
        Index('idx_documents_hospital_status', 'hospital_id', 'ocr_status', 'verification_status'),
        Index('idx_documents_lifecycle', 'hospital_id', 'lifecycle_status', 'queue_status'),
        Index('idx_documents_module_record', 'hospital_id', 'module_name', 'module_record_id'),
        Index('idx_documents_patient_module', 'hospital_id', 'patient_id', 'module_name')
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doc_type: Mapped[str] = mapped_column(Text, nullable=False)
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    patient_id: Mapped[Optional[str]] = mapped_column(Text)
    admission_id: Mapped[Optional[int]] = mapped_column(Integer)
    file_name: Mapped[Optional[str]] = mapped_column(Text)
    mime_type: Mapped[Optional[str]] = mapped_column(Text)
    file_data: Mapped[Optional[bytes]] = mapped_column(LargeBinary)
    ocr_text: Mapped[Optional[str]] = mapped_column(Text)
    ocr_language: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'en'::text"))
    created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))
    hospital_id: Mapped[Optional[int]] = mapped_column(Integer)
    module_name: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'Repository'::text"))
    ocr_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'pending'::text"))
    verification_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'pending'::text"))
    ai_confidence: Mapped[Optional[float]] = mapped_column(REAL, server_default=text('0'))
    file_hash: Mapped[Optional[str]] = mapped_column(Text)
    file_size: Mapped[Optional[int]] = mapped_column(Integer, server_default=text('0'))
    classification: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'Others'::text"))
    extracted_json: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'{}'::text"))
    tags_json: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'[]'::text"))
    uploaded_by: Mapped[Optional[str]] = mapped_column(Text)
    verified_by: Mapped[Optional[str]] = mapped_column(Text)
    verified_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    module_record_id: Mapped[Optional[str]] = mapped_column(Text)
    lifecycle_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'uploaded'::text"))
    queue_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'pending'::text"))
    security_status: Mapped[Optional[str]] = mapped_column(Text, server_default=text("'checked'::text"))
    indexed_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime)
    folder_path: Mapped[Optional[str]] = mapped_column(Text)
    thumbnail_path: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, server_default=text('CURRENT_TIMESTAMP'))

    admission: Mapped[Optional['Admissions']] = relationship('Admissions', back_populates='documents')
    patient: Mapped[Optional['Patients']] = relationship('Patients', back_populates='documents')
