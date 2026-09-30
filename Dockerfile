# Lumen server image: FastAPI backend + the prebuilt frontend in one process.
#
# Build the frontend first (npm run build in frontend/); this image only copies frontend/dist,
# so the server that builds it needs no Node toolchain.
#
#   docker build -t lumen .
#   docker run -p 8000:8000 -v ./data/cache:/app/data/cache lumen
#
# data/cache (shadow frames, evaluation) and data/whatif (saved plans) are the only paths the
# server writes; mount them so the container itself can run read-only.
FROM python:3.12-slim

# Mirror override for builds inside mainland China (e.g. --build-arg PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple)
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --index-url "$PIP_INDEX_URL" -r backend/requirements.txt

COPY backend/server.py backend/
COPY backend/lumen backend/lumen
COPY data/raw data/raw
COPY frontend/dist frontend/dist
RUN mkdir -p data/cache data/whatif && chown 10001:10001 data/cache data/whatif

ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/fineyh/lumen-cremorne" \
      org.opencontainers.image.revision="$REVISION"

USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/meta', timeout=4)"]
CMD ["python", "backend/server.py"]
