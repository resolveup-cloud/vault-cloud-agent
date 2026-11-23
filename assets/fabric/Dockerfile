# Vault Fabric runner profile: the vault-agent binary alone, as an unprivileged user.
# No Desktop runtime, no account credential and no host project mount: jobs run in
# Fabric job worktrees materialized inside the container's own data volume.
FROM ubuntu:24.04@sha256:a853f94d226358a79c740cfc7bce0c289748f3fe3488d921d038ccd752c61b60
ARG VAULT_AGENT_SHA256
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/*

COPY vault-agent /usr/local/bin/vault-agent
RUN [[ "${VAULT_AGENT_SHA256}" =~ ^[a-f0-9]{64}$ ]] \
    && printf '%s  /usr/local/bin/vault-agent\n' "${VAULT_AGENT_SHA256}" | sha256sum --check --status \
    && chmod 0755 /usr/local/bin/vault-agent

RUN if id ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
    && useradd --uid 1000 --create-home --shell /bin/bash vault \
    && chmod 0750 /home/vault
COPY entrypoint.sh /usr/local/bin/vault-fabric-runner
RUN chmod 0755 /usr/local/bin/vault-fabric-runner

LABEL org.opencontainers.image.title="vault-cloud-agent-fabric-runner" \
      dev.vault.vault-agent-sha256="${VAULT_AGENT_SHA256}"
ENV HOME=/home/vault \
    VAULT_AGENT_CONFIG_DIR=/home/vault/fabric/config \
    VAULT_AGENT_CACHE_DIR=/home/vault/fabric/cache
USER vault:vault
WORKDIR /home/vault
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/vault-fabric-runner"]
CMD ["run"]
