# syntax=docker/dockerfile:1.7
# Build context = hospai-demo/ (the parent of hosp_deploy/)
ARG NODE_VERSION=20
ARG PYTHON_VERSION=3.12
ARG NGINX_VERSION=1.27

# ================= FRONTEND =================
FROM node:${NODE_VERSION}-alpine AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:${NGINX_VERSION}-alpine AS frontend
COPY --chown=101:101 hosp_deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build --chown=101:101 /build/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

# ================= BACKEND =================
FROM python:${PYTHON_VERSION}-slim-bookworm AS py-build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libpq-dev \
 && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY backend/requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip pip install -r /tmp/requirements.txt

FROM python:${PYTHON_VERSION}-slim-bookworm AS backend
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH" TZ=Asia/Kolkata
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 tini tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app \
 && useradd  --system --uid 10001 --gid app --home /app --shell /usr/sbin/nologin app
COPY --from=py-build /opt/venv /opt/venv
WORKDIR /app
COPY --chown=app:app backend /app/backend
RUN mkdir -p /app/backend/uploads && chown app:app /app/backend/uploads
USER 10001:10001
WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=5 \
  CMD python -c "import socket; socket.create_connection(('127.0.0.1',8000),2)" || exit 1
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["uvicorn","main:app","--host","0.0.0.0","--port","8000","--workers","1","--proxy-headers","--forwarded-allow-ips=*"]
