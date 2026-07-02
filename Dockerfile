FROM python:3.11-slim

# System deps for python-docx (lxml) and pdfplumber
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2 \
    libxslt1.1 \
    zlib1g \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# DATA_DIR is mounted as a Fly.io persistent volume — survives deploys and restarts.
# SQLite DB, user CVs, and .tmp/ output all live here.
ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 8080

# 2 workers is safe with SQLite (check_same_thread=False).
# Increase --timeout for long-running pipeline requests.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "120", "app:app"]
