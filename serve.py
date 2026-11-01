#!/usr/bin/env python3
"""Static server + POST /log -> JSONL, GET/POST /prefs -> data/prefs.json."""
import http.server, json, time, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7814
LOG = "/tmp/bmx-proto-console.jsonl"
PREFS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "prefs.json")

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store"); super().end_headers()

    def do_GET(self):
        if self.path != "/prefs":
            return super().do_GET()
        body = open(PREFS, "rb").read() if os.path.exists(PREFS) else b"{}"
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/prefs":
            tmp = PREFS + ".tmp"
            with open(tmp, "wb") as f: f.write(json.dumps(json.loads(body), indent=1).encode())
            os.replace(tmp, PREFS)
        elif self.path == "/log":
            try: rec = json.loads(body)
            except Exception: rec = {"raw": body.decode(errors="replace")}
            rec["t"] = time.strftime("%H:%M:%S")
            with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n")
        else:
            return self.send_error(404)
        self.send_response(204); self.end_headers()

    def log_message(self, *a): pass

http.server.ThreadingHTTPServer(("", PORT), H).serve_forever()
