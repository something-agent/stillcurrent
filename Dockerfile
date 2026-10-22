FROM python:3.13-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.lock requirements.txt ./
RUN pip install --no-cache-dir -r requirements.lock
COPY app ./app
# Non-root user with uid 1000 (required by Hugging Face Docker Spaces; harmless elsewhere).
RUN useradd -m -u 1000 user && chown -R user /app
USER user
ENV HOME=/home/user
# Default 7860 (Hugging Face Spaces app_port). Platforms that inject PORT (e.g. Render) override it.
ENV PORT=7860
EXPOSE 7860
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*' --timeout-keep-alive 30"]
