FROM node:22.23.1-trixie-slim

ARG DEBIAN_FRONTEND=noninteractive

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    HOME=/workspace/.desktop-home \
    DISPLAY=:1 \
    COKE_DESKTOP_RESOLUTION=1440x900 \
    COKE_DESKTOP_START_URL=https://example.com

RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      ca-certificates chromium curl dbus-x11 fonts-dejavu-core fonts-noto-cjk git locales \
      novnc scrot tini util-linux websockify x11-utils x11vnc xdotool xfce4 xfce4-terminal xvfb \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      file jq poppler-utils ripgrep unzip xxd zip python3-venv python3-bs4 python3-docx \
      python3-lxml python3-openpyxl python3-pandas python3-pymupdf python3-pypdf python3-requests \
    && sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

ENV PATH=/opt/coke-dots/python/bin:$PATH \
    NPM_CONFIG_CACHE=/workspace/.cache/npm \
    PIP_CACHE_DIR=/workspace/.cache/pip \
    DOTS_RESEARCH_TOOLS=1

RUN install -d -o node -g node /workspace /opt/coke-dots /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && /usr/bin/python3 -m venv --system-site-packages /opt/coke-dots/python \
    && chown -R node:node /opt/coke-dots/python

WORKDIR /opt/coke-dots
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci --cache /tmp/dots-build-npm-cache --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm -rf /tmp/dots-build-npm-cache \
    && install -d -o node -g node "$HOME" "$HOME/.config" "$HOME/.vnc" /workspace/.cache /workspace/.cache/npm /workspace/.cache/pip
RUN node --input-type=module -e "await import('@mariozechner/pi-coding-agent'); await import('@browser_use/pi'); await import('typebox')"
RUN python3 -c "import bs4, docx, pymupdf, lxml, openpyxl, pandas, pypdf, requests" \
    && for tool in pdftotext pdfinfo pdftoppm rg jq file unzip zip xxd; do command -v "$tool"; done

COPY --chmod=0755 deploy/linux-desktop/start-desktop.sh /usr/local/bin/start-dots-desktop
COPY --chmod=0644 deploy/linux-desktop/computer-worker.mjs /opt/coke-dots/computer-worker.mjs
COPY --chmod=0644 deploy/linux-desktop/browser-context.mjs /opt/coke-dots/browser-context.mjs
COPY --chmod=0644 deploy/linux-desktop/renderer-health.mjs /opt/coke-dots/renderer-health.mjs
COPY --chmod=0644 deploy/linux-desktop/agent-runtime.mjs /opt/coke-dots/agent-runtime.mjs
COPY --chmod=0644 deploy/linux-desktop/agent-progress.mjs /opt/coke-dots/agent-progress.mjs
COPY --chmod=0644 deploy/linux-desktop/cloud-kernel-adapter.mjs /opt/coke-dots/cloud-kernel-adapter.mjs
COPY --chmod=0644 deploy/linux-desktop/task-delegation.mjs /opt/coke-dots/task-delegation.mjs
COPY --chmod=0644 deploy/linux-desktop/pi-turn-runner.mjs /opt/coke-dots/pi-turn-runner.mjs
COPY --chmod=0644 deploy/linux-desktop/csv-delivery.mjs /opt/coke-dots/csv-delivery.mjs
COPY --chmod=0644 deploy/linux-desktop/browser-executor.mjs deploy/linux-desktop/browser-helpers.js deploy/linux-desktop/model-policy.mjs deploy/linux-desktop/agent-metrics.mjs deploy/linux-desktop/agent-limits.mjs /opt/coke-dots/
COPY --chmod=0755 deploy/linux-desktop/incident-git-credential-helper.mjs /opt/coke-dots/incident-git-credential-helper.mjs
COPY --chmod=0644 deploy/linux-desktop/incident-git-credential-server.mjs /opt/coke-dots/incident-git-credential-server.mjs

ARG COKE_DOTS_GIT_REVISION=unknown
LABEL org.opencontainers.image.revision=$COKE_DOTS_GIT_REVISION

USER 1000:1000
WORKDIR /workspace

EXPOSE 6080 8082 8083
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 CMD curl --fail --silent http://127.0.0.1:8082/readyz >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-dots-desktop"]
