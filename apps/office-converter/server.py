"""
Word -> PDF for Botwa's digital forms. A tiny HTTP service around LibreOffice, meant to run in its own container on an internal
network with no internet access. It never runs macros, keeps nothing (a fresh temporary directory and profile per document),
converts one document at a time, and stops any conversion that takes longer than the limit.
  POST /convert   body: the .docx / .doc bytes (at most 15 MB)   ->  200 application/pdf, or 4xx/5xx with a short error
  GET  /health    -> 200 "ok"
"""
import os, shutil, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX = 15 * 1024 * 1024
TIMEOUT = int(os.environ.get('CONVERT_TIMEOUT', '90'))
SOFFICE = os.environ.get('SOFFICE', 'soffice')
LOCK = threading.Lock()
ZIP, OLE = b'PK\x03\x04', b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'   # .docx is a zip; old .doc is an OLE file


def convert(data: bytes) -> bytes:
    ext = 'docx' if data.startswith(ZIP) else 'doc'
    with LOCK, tempfile.TemporaryDirectory(prefix='conv-') as d:
        src = os.path.join(d, 'in.' + ext)
        with open(src, 'wb') as f:
            f.write(data)
        profile = os.path.join(d, 'profile')
        cmd = [SOFFICE, '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', '--invisible',
               f'-env:UserInstallation=file://{profile}', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', d, src]
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=TIMEOUT, env={'HOME': d, 'PATH': os.environ.get('PATH', '/usr/bin:/bin')})
        out = os.path.join(d, 'in.pdf')
        if r.returncode != 0 or not os.path.exists(out):
            raise RuntimeError('convert_failed')
        with open(out, 'rb') as f:
            pdf = f.read()
        if not pdf.startswith(b'%PDF'):
            raise RuntimeError('convert_failed')
        return pdf


class Handler(BaseHTTPRequestHandler):
    server_version = 'office-converter'
    sys_version = ''

    def log_message(self, fmt, *args):   # no document names or contents in logs
        return

    def reply(self, code, body, ctype='text/plain; charset=utf-8'):
        self.send_response(code)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, b'ok')
        self.reply(404, b'not_found')

    def do_POST(self):
        if self.path != '/convert':
            return self.reply(404, b'not_found')
        try:
            n = int(self.headers.get('content-length', '0'))
        except ValueError:
            return self.reply(400, b'bad_request')
        if n <= 0 or n > MAX:
            return self.reply(413, b'too_large')
        data = self.rfile.read(n)
        if not (data.startswith(ZIP) or data.startswith(OLE)):
            return self.reply(415, b'not_a_word_document')
        try:
            pdf = convert(data)
        except subprocess.TimeoutExpired:
            return self.reply(504, b'timeout')
        except Exception:
            return self.reply(422, b'convert_failed')
        self.reply(200, pdf, 'application/pdf')


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8090'))
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
