FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV DOWNLOADER_STORAGE_DIR=/data/files
ENV DOWNLOADER_API_KEY=change-me
ENV DOWNLOADER_PUBLIC_BASE_URL=http://localhost:8081

RUN mkdir -p /data/files

EXPOSE 8081
CMD ["uvicorn", "app.safe_main:app", "--host", "0.0.0.0", "--port", "8081"]
