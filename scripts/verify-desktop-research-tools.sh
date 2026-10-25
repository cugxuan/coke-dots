#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
image="${1:?Usage: verify-desktop-research-tools.sh <desktop-image>}"
docker_command=(docker)
if [[ -n "${DOCKER_HOST:-}" ]]; then docker_command+=(--host "$DOCKER_HOST"); fi

# No live tenant volume, network, credentials, or privileged user is needed.
"${docker_command[@]}" run --rm -i --network none --entrypoint python3 "$image" - \
  < "$repo_root/tests/e2e/research-tools.e2e.py"
