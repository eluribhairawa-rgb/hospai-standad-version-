"""Draft "Summary / interpretation" text for a LAB report.

The pathologist asks for a draft, reviews it and edits it in the report; nothing
is saved from here. When every value is within range no model is called. Otherwise
the Qwen model writes 1-3 cautious sentences from the de-identified results, and
any sentence quoting a number that is not in those results is dropped.
"""
import re

from qwen_ocr import _chat

ABNORMAL_FLAGS = {"high", "low", "critical_high", "critical_low", "abnormal"}
ALL_NORMAL_TEXT = "All parameters are within the reference range."

INTERPRETATION_PROMPT = """You are assisting a pathologist. Write the "Summary / interpretation" line for a laboratory report.

Test: {service_name}
Patient: {patient}
Results (parameter: value unit [reference range] flag):
{results}

Rules:
- 1 to 3 short sentences, plain text, no headings, bullets or markdown.
- Name each abnormal parameter and whether it is high or low. Quote values only exactly as given above.
- Add the usual clinical significance in cautious words ("suggestive of", "may indicate"). Never state a definite diagnosis.
- If a standard follow-up test is commonly advised for this pattern, suggest it in a few words ("Suggest HbA1c.").
- Mention critical values first and say "Critical value" for them.
- Do not repeat normal parameters."""


def _value(r):
    return r.get("value_numeric") if r.get("value_numeric") is not None else r.get("value_text")


def _range(r):
    if r.get("ref_range_text"):
        return r["ref_range_text"]
    if r.get("ref_low") is not None or r.get("ref_high") is not None:
        return f"{r.get('ref_low') if r.get('ref_low') is not None else ''}-{r.get('ref_high') if r.get('ref_high') is not None else ''}"
    return "-"


def _numbers(text):
    # Digits right after a letter are part of a name (HbA1c, B12, T4), not a value.
    found = re.findall(r"(?<![A-Za-z\d.])\d+(?:\.\d+)?", text or "")
    return {n.rstrip("0").rstrip(".") if "." in n else n for n in found}


def _grounded(text, source):
    """Drops sentences that quote a number the results do not contain."""
    allowed = _numbers(source)
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    kept = [s for s in sentences if _numbers(s) <= allowed]
    return " ".join(kept).strip()


def draft_lab_interpretation(service_name, results, age=None, gender=None):
    """Returns {"summary", "source"}: "rule" when no model call was needed, else "ai"."""
    entered = [r for r in results or [] if _value(r) not in (None, "")]
    if not entered:
        raise ValueError("No result values are entered for this test yet.")
    if not any((r.get("flag") or "") in ABNORMAL_FLAGS for r in entered):
        return {"summary": ALL_NORMAL_TEXT, "source": "rule"}
    lines = "\n".join(
        f"- {r.get('parameter_name')}: {_value(r)} {r.get('unit') or ''} [{_range(r)}] {(r.get('flag') or 'normal').replace('_', ' ')}"
        for r in entered
    )
    patient = ", ".join(p for p in (f"{age} years" if age not in (None, "") else "", gender or "") if p) or "not stated"
    raw = _chat(INTERPRETATION_PROMPT.format(service_name=service_name or "Laboratory test", patient=patient, results=lines),
                max_tokens=300)
    text = re.sub(r"^```\w*|```$", "", raw.strip()).strip().strip('"')
    summary = _grounded(re.sub(r"\s+", " ", text), lines)
    if not summary:
        raise RuntimeError("The AI model did not return a usable summary. Please write it manually or try again.")
    return {"summary": summary, "source": "ai"}
