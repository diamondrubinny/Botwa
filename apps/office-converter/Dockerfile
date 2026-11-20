# Word -> PDF converter for Botwa's digital forms (LibreOffice, no network, no macros, nothing kept). Built and started by
# scripts/enable-office.sh; reachable only by the Botwa server on an internal network.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer-nogui python3 fonts-dejavu-core fonts-noto-core fonts-noto-ui-core \
 && rm -rf /var/lib/apt/lists/* && useradd --system --create-home --uid 10010 conv
COPY server.py /app/server.py
USER conv
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4)"
CMD ["python3", "/app/server.py"]
