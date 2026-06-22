FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 libgomp1 git curl && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api_server.py .
RUN mkdir -p models/.cache
EXPOSE 3003
HEALTHCHECK --interval=60s --timeout=30s --retries=3 \
  CMD curl -f http://localhost:3003/health || exit 1
CMD ["python", "api_server.py"]
