-- ====================================================================
-- Migrations for Billing & Accounts Department (HospAI HMS)
-- Fully additive, NUMERIC(12,2) precision, zero destructive changes.
-- ====================================================================

-- 1. Cashier Sessions (Counter Drawer Reconciliation)
CREATE TABLE IF NOT EXISTS cashier_sessions (
    id SERIAL PRIMARY KEY,
    session_code TEXT UNIQUE NOT NULL,
    cashier_username TEXT NOT NULL,
    cashier_name TEXT NOT NULL,
    counter_name TEXT NOT NULL DEFAULT 'Main Billing Counter',
    opening_float NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (opening_float >= 0),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMPTZ,
    cash_received NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (cash_received >= 0),
    cash_refunded NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (cash_refunded >= 0),
    cash_handover NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (cash_handover >= 0),
    cash_movements NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    cash_doctor_payouts NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (cash_doctor_payouts >= 0),
    expected_cash NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    counted_cash NUMERIC(12, 2),
    variance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    notes TEXT,
    closed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cashier_sessions_status ON cashier_sessions(status);
CREATE INDEX IF NOT EXISTS idx_cashier_sessions_cashier ON cashier_sessions(cashier_username);

-- 2. Authorised Drawer Movements (Handover / Petty Cash / Adjustments)
CREATE TABLE IF NOT EXISTS cashier_drawer_movements (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES cashier_sessions(id) ON DELETE RESTRICT,
    movement_type TEXT NOT NULL CHECK (movement_type IN ('handover', 'cash_in', 'cash_out', 'doctor_payout')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    recipient_or_source TEXT NOT NULL,
    reason TEXT NOT NULL,
    authorised_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_drawer_movements_session ON cashier_drawer_movements(session_id);

-- 3. Financial Receipts (Single receipt issued to patient/payer)
CREATE TABLE IF NOT EXISTS financial_receipts (
    id SERIAL PRIMARY KEY,
    receipt_no TEXT UNIQUE NOT NULL,
    receipt_type TEXT NOT NULL CHECK (receipt_type IN ('bill_payment', 'advance', 'refund_voucher')),
    patient_id TEXT NOT NULL REFERENCES patients(patient_id) ON DELETE RESTRICT,
    admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
    total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount > 0),
    cashier_session_id INTEGER REFERENCES cashier_sessions(id) ON DELETE SET NULL,
    is_reversed BOOLEAN NOT NULL DEFAULT FALSE,
    reversal_reason TEXT,
    reversal_date TIMESTAMPTZ,
    reversed_by TEXT,
    notes TEXT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_financial_receipts_patient ON financial_receipts(patient_id);
CREATE INDEX IF NOT EXISTS idx_financial_receipts_session ON financial_receipts(cashier_session_id);
CREATE INDEX IF NOT EXISTS idx_financial_receipts_created ON financial_receipts(created_at);
CREATE INDEX IF NOT EXISTS idx_financial_receipts_type ON financial_receipts(receipt_type);

-- 4. Receipt Payment Lines (Split payment methods: Cash, UPI, Card, etc.)
CREATE TABLE IF NOT EXISTS receipt_payment_lines (
    id SERIAL PRIMARY KEY,
    receipt_id INTEGER NOT NULL REFERENCES financial_receipts(id) ON DELETE CASCADE,
    payment_mode TEXT NOT NULL CHECK (payment_mode IN ('cash', 'card', 'upi', 'bank_transfer', 'net_banking', 'cheque', 'advance_allocation')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    transaction_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_receipt_payment_lines_receipt ON receipt_payment_lines(receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_payment_lines_mode ON receipt_payment_lines(payment_mode);

-- 5. Receipt Invoice Allocations (Which bills this receipt paid)
CREATE TABLE IF NOT EXISTS receipt_invoice_allocations (
    id SERIAL PRIMARY KEY,
    receipt_id INTEGER NOT NULL REFERENCES financial_receipts(id) ON DELETE CASCADE,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    allocated_amount NUMERIC(12, 2) NOT NULL CHECK (allocated_amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_receipt_allocations_receipt ON receipt_invoice_allocations(receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_allocations_invoice ON receipt_invoice_allocations(invoice_id);

-- 6. Patient Advances
CREATE TABLE IF NOT EXISTS patient_advances (
    id SERIAL PRIMARY KEY,
    advance_no TEXT UNIQUE NOT NULL,
    patient_id TEXT NOT NULL REFERENCES patients(patient_id) ON DELETE RESTRICT,
    admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    allocated_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (allocated_amount >= 0),
    refunded_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (refunded_amount >= 0),
    reserved_refund_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (reserved_refund_amount >= 0),
    payment_mode TEXT NOT NULL,
    transaction_ref TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fully_allocated', 'refunded')),
    notes TEXT,
    receipt_id INTEGER REFERENCES financial_receipts(id) ON DELETE SET NULL,
    cashier_session_id INTEGER REFERENCES cashier_sessions(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_patient_advances_patient ON patient_advances(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_advances_admission ON patient_advances(admission_id);

-- 7. Advance Allocations (When an advance pays an invoice)
CREATE TABLE IF NOT EXISTS advance_allocations (
    id SERIAL PRIMARY KEY,
    advance_id INTEGER NOT NULL REFERENCES patient_advances(id) ON DELETE RESTRICT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    allocated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_advance_allocations_advance ON advance_allocations(advance_id);
CREATE INDEX IF NOT EXISTS idx_advance_allocations_invoice ON advance_allocations(invoice_id);

-- 8. Refund Requests & Payments
CREATE TABLE IF NOT EXISTS refund_requests (
    id SERIAL PRIMARY KEY,
    refund_no TEXT UNIQUE NOT NULL,
    patient_id TEXT NOT NULL REFERENCES patients(patient_id) ON DELETE RESTRICT,
    admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
    advance_id INTEGER REFERENCES patient_advances(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    original_receipt_id INTEGER REFERENCES financial_receipts(id) ON DELETE SET NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    reason TEXT NOT NULL,
    refund_method TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('awaiting_approval', 'approved', 'rejected', 'paid', 'cancelled')),
    requested_by TEXT NOT NULL,
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    rejected_by TEXT,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    paid_by TEXT,
    paid_at TIMESTAMPTZ,
    payment_ref TEXT,
    voucher_receipt_id INTEGER REFERENCES financial_receipts(id) ON DELETE SET NULL,
    cashier_session_id INTEGER REFERENCES cashier_sessions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_refund_requests_patient ON refund_requests(patient_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON refund_requests(status);
CREATE INDEX IF NOT EXISTS idx_refund_requests_advance ON refund_requests(advance_id);

-- 9. Doctor Agreements (Contractual percentage or fee shares)
CREATE TABLE IF NOT EXISTS doctor_agreements (
    id SERIAL PRIMARY KEY,
    doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doctor_name TEXT NOT NULL,
    department TEXT,
    consultation_share_pct NUMERIC(5, 2) NOT NULL DEFAULT 80.00 CHECK (consultation_share_pct >= 0 AND consultation_share_pct <= 100),
    review_share_pct NUMERIC(5, 2) NOT NULL DEFAULT 80.00 CHECK (review_share_pct >= 0 AND review_share_pct <= 100),
    procedure_share_pct NUMERIC(5, 2) NOT NULL DEFAULT 70.00 CHECK (procedure_share_pct >= 0 AND procedure_share_pct <= 100),
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(doctor_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_doctor_agreements_doctor ON doctor_agreements(doctor_id);

-- 10. Doctor Statements (Monthly billing statements for doctor payout reconciliation)
CREATE TABLE IF NOT EXISTS doctor_statements (
    id SERIAL PRIMARY KEY,
    statement_no TEXT UNIQUE NOT NULL,
    doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    doctor_name TEXT NOT NULL,
    department TEXT,
    period_month TEXT NOT NULL, -- 'YYYY-MM'
    fees_earned NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (fees_earned >= 0),
    adjustments NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    net_payable NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (paid_amount >= 0),
    remaining_payable NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (remaining_payable >= 0),
    status TEXT NOT NULL DEFAULT 'ready_for_review' CHECK (status IN ('draft', 'ready_for_review', 'approved')),
    payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid')),
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(doctor_id, period_month)
);
CREATE INDEX IF NOT EXISTS idx_doctor_statements_doctor ON doctor_statements(doctor_id);
CREATE INDEX IF NOT EXISTS idx_doctor_statements_month ON doctor_statements(period_month);

-- 11. Doctor Statement Lines (Traceable itemized earnings preventing double claims)
CREATE TABLE IF NOT EXISTS doctor_statement_lines (
    id SERIAL PRIMARY KEY,
    statement_id INTEGER NOT NULL REFERENCES doctor_statements(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('appointment', 'ip_consultation', 'procedure', 'adjustment')),
    source_id INTEGER NOT NULL,
    service_name TEXT NOT NULL,
    patient_name TEXT,
    service_date DATE NOT NULL,
    bill_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    earning_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_doctor_statement_lines_stmt ON doctor_statement_lines(statement_id);

-- 12. Financial Idempotency Log (Enforces safe retries without double charging)
CREATE TABLE IF NOT EXISTS financial_idempotency_log (
    id SERIAL PRIMARY KEY,
    hospital_id INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT NOT NULL,
    request_path TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(hospital_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_financial_idempotency_key ON financial_idempotency_log(hospital_id, idempotency_key);

-- 13. Compatibility extensions to invoice_payments (to link canonical receipts safely)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'invoice_payments' AND column_name = 'canonical_receipt_id'
    ) THEN
        ALTER TABLE invoice_payments ADD COLUMN canonical_receipt_id INTEGER REFERENCES financial_receipts(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'invoice_payments' AND column_name = 'canonical_allocation_id'
    ) THEN
        ALTER TABLE invoice_payments ADD COLUMN canonical_allocation_id INTEGER REFERENCES receipt_invoice_allocations(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'invoice_payments' AND column_name = 'receipt_no'
    ) THEN
        ALTER TABLE invoice_payments ADD COLUMN receipt_no TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'doctor_payout_payments' AND column_name = 'cashier_session_id'
    ) THEN
        ALTER TABLE doctor_payout_payments ADD COLUMN cashier_session_id INTEGER REFERENCES cashier_sessions(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'doctor_payout_payments' AND column_name = 'payment_mode'
    ) THEN
        ALTER TABLE doctor_payout_payments ADD COLUMN payment_mode VARCHAR(32) DEFAULT 'bank_transfer';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'doctor_payout_payments' AND column_name = 'transaction_ref'
    ) THEN
        ALTER TABLE doctor_payout_payments ADD COLUMN transaction_ref VARCHAR(128);
    END IF;
END $$;
