FROM python:3.11-slim

WORKDIR /app

# Install build essentials (some SDK deps need them)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy backend pyproject + sdk tarball first (for layer caching)
COPY python-backend/pyproject.toml /app/
COPY sdk-vendor/browserstack_ai_sdk-1.0.0a31.tar.gz /app/sdk-vendor/

# Install: backend deps first, then the local TestOps SDK
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -e /app && \
    pip install --no-cache-dir /app/sdk-vendor/browserstack_ai_sdk-1.0.0a31.tar.gz

# Copy backend source
COPY python-backend/ /app/

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
