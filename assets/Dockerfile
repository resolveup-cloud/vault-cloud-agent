# User-owned runtime; no managed controller, host agent or provider configuration.
FROM ubuntu:24.04@sha256:a853f94d226358a79c740cfc7bce0c289748f3fe3488d921d038ccd752c61b60
ARG VAULT_VERSION
ARG VAULT_SHA256
ARG VAULT_DOWNLOAD_URL
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 python3-venv build-essential ripgrep tmux \
    tini procps openssh-client squashfs-tools xvfb xz-utils \
    libgtk-3-0t64 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libgbm1 libasound2t64 \
    libxtst6 libcups2t64 libdrm2 libxkbcommon0 libpango-1.0-0 libcairo2 libatspi2.0-0t64 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxrender1 libx11-xcb1 libxcb-dri3-0 libxss1 \
    && rm -rf /var/lib/apt/lists/*

# Claude Code requires Node >=22; Ubuntu's Node 18 is unsupported. Match the managed runtime.
RUN curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
      --output /tmp/node.tar.xz https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz \
    && printf '%s  /tmp/node.tar.xz\n' \
      'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6' | sha256sum --check --status \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && rm /tmp/node.tar.xz \
    && test "$(node --version)" = v24.21.0

COPY extract-runtime.py /usr/local/lib/vault-cloud-agent/extract-runtime.py
RUN [[ "${VAULT_SHA256}" =~ ^[a-f0-9]{64}$ ]] && [[ "${VAULT_DOWNLOAD_URL}" == https://* ]] \
    && curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
         --retry 3 --output /tmp/vault.AppImage "${VAULT_DOWNLOAD_URL}" \
    && printf '%s  /tmp/vault.AppImage\n' "${VAULT_SHA256}" | sha256sum --check --status \
    && python3 /usr/local/lib/vault-cloud-agent/extract-runtime.py /tmp/vault.AppImage \
    && rm /tmp/vault.AppImage

# Same pinned agent CLIs as the Vault managed runtime; user's own login is required.
# Audit registry signatures before the single native-binary copy lifecycle step.
RUN mkdir -p /usr/local/lib/vault-agent-clis \
    && cd /usr/local/lib/vault-agent-clis \
    && printf '%s\n' '{"name":"vault-agent-clis","private":true}' > package.json \
    && npm install --ignore-scripts --save-exact --no-fund --no-audit \
         @anthropic-ai/claude-code@2.1.287 @openai/codex@0.160.0 \
    && npm audit signatures \
    && node node_modules/@anthropic-ai/claude-code/install.cjs \
    && ln -s /usr/local/lib/vault-agent-clis/node_modules/.bin/claude /usr/local/bin/claude \
    && ln -s /usr/local/lib/vault-agent-clis/node_modules/.bin/codex /usr/local/bin/codex \
    && chmod -R go-w /usr/local/lib/vault-agent-clis && rm -rf /root/.npm /root/.cache

RUN if id ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
    && useradd --uid 1000 --create-home --shell /bin/bash vault \
    && chmod 0750 /home/vault
COPY capture-ready.py health.py /usr/local/lib/vault-cloud-agent/
COPY start.sh /usr/local/bin/vault-cloud-agent-start
RUN chmod 0755 /usr/local/bin/vault-cloud-agent-start \
    && test -x /opt/vault/squashfs-root/vault-desktop \
    && test -f /opt/vault/squashfs-root/resources/app.asar.unpacked/out/cli/index.js

LABEL org.opencontainers.image.title="vault-cloud-agent-runtime" \
      org.opencontainers.image.version="${VAULT_VERSION}" \
      dev.vault.appimage-sha256="${VAULT_SHA256}"
ENV HOME=/home/vault DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 DISABLE_AUTOUPDATER=1
USER vault:vault
WORKDIR /home/vault
EXPOSE 6768
HEALTHCHECK --interval=5s --timeout=3s --start-period=120s --retries=3 \
    CMD ["python3", "/usr/local/lib/vault-cloud-agent/health.py"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/vault-cloud-agent-start"]
