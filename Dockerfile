FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-java-common liblibreoffice-java \
    default-jre-headless chromium fonts-nanum fonts-noto-cjk fonts-unfonts-core \
    && rm -rf /var/lib/apt/lists/*

COPY H2Orestart-0.7.13.oxt /tmp/H2Orestart.oxt
RUN unopkg add --shared --force /tmp/H2Orestart.oxt \
    && unopkg list --shared | grep -q "H2Orestart" \
    && rm /tmp/H2Orestart.oxt

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

EXPOSE 10000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1"]
