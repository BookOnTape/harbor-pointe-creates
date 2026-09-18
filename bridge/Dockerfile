# Harbor Pointe Creates printer bridge — container build for joecool.
# Small, no ffmpeg (the Centauri Carbon 2 camera is plain MJPEG over HTTP).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bridge.py .
# Config is bind-mounted at runtime (see docker-compose.yml); never baked in.
CMD ["python", "-u", "bridge.py", "-c", "/config/config.yaml"]
