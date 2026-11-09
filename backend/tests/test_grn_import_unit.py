"""Unit tests for the unified GRN import (CSV parsing, file routing, OCR branches).
No database or OCR model server is needed: model calls are mocked.

Run from backend/:  .venv/bin/python -m unittest tests.test_grn_import_unit -v
"""
import io
import os
import sys
import unittest
from unittest import mock

os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/unit_tests")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import grn_import as gi  # noqa: E402

OCR_RESULT = {
    "supplier_name": "Apex Pharma", "supplier_gstin": "", "invoice_no": "INV-9", "invoice_date": "2026-11-01",
    "items": [{"medicine_name": "Dolo 650", "batch_no": "B1", "expiry_date": "2027-08-31", "quantity": "10"}],
}


class CsvParsingTests(unittest.TestCase):
    def test_supplier_layout_is_mapped_dynamically(self):
        csv_bytes = (
            "Product Description,Mfr,HSN,Pack,Batch No.,Exp,Qty,Free,Rate,MRP,Disc %,CGST %,SGST %,GST Amt\n"
            "Dolo 650 Tablet,Micro Labs,30049099,15x10,DL123,08/27,10,1,25.50,32.00,5,6,6,30.6\n"
            "Pan 40,Alkem,3004,10x10,PN9,AUG-2028,5,0,40,55,0,6,6,24\n"
            "Grand Total,,,,,,15,,,,,,,54.6\n"
        ).encode()
        out = gi.import_goods_receipt_file("apex.csv", csv_bytes)
        self.assertEqual(out["file_type"], "csv")
        self.assertEqual(out["processing"], "csv_direct")
        self.assertEqual(out["row_count"], 2)  # total row dropped
        m = out["field_mapping"]
        self.assertEqual(m["Product Description"], "medicine_name")
        self.assertEqual(m["Batch No."], "batch_no")
        self.assertEqual(m["Exp"], "expiry_date")
        self.assertEqual(m["Mfr"], "manufacturer")
        self.assertIsNone(m["GST Amt"])  # money column, not the rate
        first, second = out["fields"]["items"]
        self.assertEqual(first["expiry_date"], "2027-08-31")
        self.assertEqual(second["expiry_date"], "2028-08-31")
        self.assertEqual(first["gst_rate"], "12")  # CGST + SGST
        self.assertEqual(first["unit_cost"], "25.5")
        self.assertEqual(first["quantity"], "10")
        self.assertEqual(first["hsn_code"], "30049099")
        self.assertEqual(out["preview"][0]["Batch No."], "DL123")

    def test_preamble_lines_semicolon_bom_and_header_fields(self):
        csv_bytes = (
            "﻿Apex Pharma Distributors\nGSTIN 36ABCDE1234F1Z5\n\n"
            "Supplier;Invoice No;Invoice Date;Item Name;Batch;Expiry Date;Quantity\n"
            "Apex Pharma;INV-77;05/11/2026;Azithral 500;AZ1;31-Dec-2027;20\n"
        ).encode("utf-8")
        out = gi.import_goods_receipt_file("x.csv", csv_bytes)
        f = out["fields"]
        self.assertEqual((f["supplier_name"], f["invoice_no"], f["invoice_date"]), ("Apex Pharma", "INV-77", "2026-11-05"))
        self.assertEqual(f["items"][0]["expiry_date"], "2027-12-31")
        self.assertTrue(any("Skipped 3 line" in w for w in out["warnings"]))

    def test_unrecognised_columns_return_preview_with_warning(self):
        out = gi.import_goods_receipt_file("x.csv", b"Foo,Bar\n1,2\n")
        self.assertEqual(out["detected_fields"], ["Foo", "Bar"])
        self.assertEqual(out["fields"]["items"], [])
        self.assertEqual(out["preview"], [{"Foo": "1", "Bar": "2"}])
        self.assertTrue(any("No medicine" in w for w in out["warnings"]))

    def test_cp1252_and_duplicate_blank_headers(self):
        out = gi.import_goods_receipt_file("x.csv", "Item,Rate,Rate,\nCrème,1,2,3\n".encode("cp1252"))
        self.assertEqual(out["detected_fields"], ["Item", "Rate", "Rate (2)", "column_4"])
        self.assertEqual(out["fields"]["items"][0]["medicine_name"], "Crème")

    def test_header_only_and_empty(self):
        for content, status in ((b"Item,Qty\n\n", 400), (b"   \n", 400), (b"", 400)):
            with self.assertRaises(gi.GrnImportError) as ctx:
                gi.import_goods_receipt_file("x.csv", content)
            self.assertEqual(ctx.exception.status_code, status)


class DateParsingTests(unittest.TestCase):
    def test_formats(self):
        p = gi.parse_flexible_date
        self.assertEqual(p("2027-08-31"), "2027-08-31")
        self.assertEqual(p("31/08/2027"), "2027-08-31")
        self.assertEqual(p("02/27", end_of_month=True), "2027-02-28")
        self.assertEqual(p("02/2027"), "2027-02-01")
        self.assertEqual(p("Sept 2027", end_of_month=True), "2027-09-30")
        self.assertEqual(p("13/27"), "")
        self.assertEqual(p("31-Feb-2027"), "")
        self.assertEqual(p("soon"), "")


class RoutingTests(unittest.TestCase):
    def test_unsupported_and_oversized(self):
        with self.assertRaises(gi.GrnImportError) as ctx:
            gi.import_goods_receipt_file("stock.xlsx", b"PK\x03\x04data")
        self.assertEqual(ctx.exception.status_code, 415)
        with self.assertRaises(gi.GrnImportError) as ctx:
            gi.import_goods_receipt_file("a.csv", b"x" * (gi.MAX_UPLOAD_BYTES + 1))
        self.assertEqual(ctx.exception.status_code, 413)

    def test_extension_is_case_insensitive_and_magic_bytes_fallback(self):
        self.assertEqual(gi.detect_file_type("INVOICE.CSV", b"a"), "csv")
        self.assertEqual(gi.detect_file_type("Scan.JPG", b""), "image")
        self.assertEqual(gi.detect_file_type("blob", b"\x89PNG\r\n\x1a\n"), "image")
        self.assertEqual(gi.detect_file_type("blob", b"%PDF-1.7"), "pdf")

    def test_image_goes_through_ocr(self):
        with mock.patch.object(gi.qwen_ocr, "extract_supplier_invoice_fields", return_value=OCR_RESULT) as ocr:
            out = gi.import_goods_receipt_file("inv.png", b"\x89PNG....")
        ocr.assert_called_once()
        self.assertEqual((out["file_type"], out["processing"], out["row_count"]), ("image", "ocr_image", 1))
        self.assertIn("batch_no", out["detected_fields"])

    def test_csv_never_calls_ocr(self):
        with mock.patch.object(gi.qwen_ocr, "_chat") as chat:
            gi.import_goods_receipt_file("a.csv", b"Item,Qty\nX,1\n")
        chat.assert_not_called()

    def test_ocr_failures_map_to_http_errors(self):
        empty = {"supplier_name": "", "supplier_gstin": "", "invoice_no": "", "invoice_date": "", "items": []}
        cases = ((RuntimeError("model down"), 502), (ValueError("bad image"), 400), (empty, 422))
        for effect, status in cases:
            kwargs = {"side_effect": effect} if isinstance(effect, Exception) else {"return_value": effect}
            with mock.patch.object(gi.qwen_ocr, "extract_supplier_invoice_fields", **kwargs):
                with self.assertRaises(gi.GrnImportError) as ctx:
                    gi.import_goods_receipt_file("inv.jpg", b"\xff\xd8\xff")
            self.assertEqual(ctx.exception.status_code, status)


@unittest.skipIf(gi.PdfReader is None, "pypdf not installed")
class PdfTests(unittest.TestCase):
    def _text_pdf(self, text):
        from fpdf import FPDF
        pdf = FPDF()
        pdf.add_page()
        pdf.set_font("Helvetica", size=10)
        pdf.multi_cell(0, 5, text)
        return bytes(pdf.output())

    def test_text_pdf_uses_text_llm_not_vision(self):
        text = "TAX INVOICE Apex Pharma INV-9\n" + "\n".join(f"Dolo 650 B{i} 08/27 10 25.50 32.00" for i in range(10))
        with mock.patch.object(gi.qwen_ocr, "extract_supplier_invoice_from_text", return_value=OCR_RESULT) as txt, \
                mock.patch.object(gi.qwen_ocr, "extract_supplier_invoice_fields") as vision:
            out = gi.import_goods_receipt_file("inv.pdf", self._text_pdf(text))
        txt.assert_called_once()
        vision.assert_not_called()
        self.assertEqual((out["file_type"], out["processing"]), ("pdf", "pdf_text"))

    def test_pdf_without_text_or_images_is_rejected(self):
        with self.assertRaises(gi.GrnImportError) as ctx:
            gi.import_goods_receipt_file("blank.pdf", self._text_pdf(" "))
        self.assertEqual(ctx.exception.status_code, 422)

    def test_scanned_pdf_ocrs_page_image(self):
        from fpdf import FPDF
        from PIL import Image
        img = io.BytesIO()
        Image.new("RGB", (800, 1100), "white").save(img, format="PNG")
        pdf = FPDF()
        pdf.add_page()
        pdf.image(io.BytesIO(img.getvalue()), x=0, y=0, w=210)
        with mock.patch.object(gi.qwen_ocr, "extract_supplier_invoice_fields", return_value=OCR_RESULT) as vision:
            out = gi.import_goods_receipt_file("scan.pdf", bytes(pdf.output()))
        vision.assert_called_once()
        self.assertEqual(out["processing"], "pdf_scan_ocr")

    def test_fake_pdf(self):
        with self.assertRaises(gi.GrnImportError) as ctx:
            gi.import_goods_receipt_file("x.pdf", b"not a pdf")
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
