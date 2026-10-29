"""Stand-in for the Qwen OCR model (OpenAI-compatible /v1/chat/completions) used only by
the Selenium suite, so the lab OCR workflow is exercised end to end without the real
model. Tests set what the next "scanned sheet" contains with POST /__set:

    {"patient_name": "...", "sample_id": "...", "equipment": "...", "values": {"Haemoglobin": "13,4"}}

Parameter names are matched against the "- id N: Name (...)" lines in the prompt the
backend sends, exactly like the real model is asked to do.
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SHEET = {"patient_name": "", "sample_id": "", "equipment": "", "values": {}}
CALLS = []


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("ocr_stub: " + fmt % args + "\n")

    def do_GET(self):
        if self.path == "/__calls":
            return self._json(200, {"calls": CALLS})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path == "/__set":
            SHEET.update({k: body.get(k, SHEET[k]) for k in SHEET})
            return self._json(200, {"ok": True})
        if self.path.rstrip("/").endswith("/chat/completions"):
            prompt = next((c["text"] for c in body["messages"][0]["content"] if c.get("type") == "text"), "")
            has_image = any(c.get("type") == "image_url" for c in body["messages"][0]["content"])
            params = {name.strip(): int(pid) for pid, name in re.findall(r"- id (\d+): ([^(\n]+)", prompt)}
            CALLS.append({"params": params, "has_image": has_image})
            results = [{"parameter_id": params[n], "value": v} for n, v in SHEET["values"].items() if n in params]
            content = json.dumps({"results": results, "equipment": SHEET["equipment"],
                                  "patient_name": SHEET["patient_name"], "sample_id": SHEET["sample_id"]})
            return self._json(200, {"choices": [{"message": {"role": "assistant", "content": content}}]})
        return self._json(404, {"error": "not found"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
