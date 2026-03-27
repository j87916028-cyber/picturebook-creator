FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Run as non-root for defense-in-depth — limits blast radius if the
# process is compromised (e.g. via a dependency vulnerability).
RUN useradd -r -s /usr/sbin/nologin appuser
USER appuser

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
