#!/usr/bin/env bash
set -euo pipefail

# Works with the local engine or command-scoped DOCKER_HOST=ssh://<SSH alias>.
repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo_root"
revision=$(git rev-parse HEAD)
image="coke-dots-linux-desktop:sha-${revision}"
docker_command=(docker)
if [[ -n "${DOCKER_HOST:-}" ]]; then docker_command+=(--host "$DOCKER_HOST"); fi
image_inputs=(deploy/linux-desktop package.json package-lock.json .dockerignore scripts/build-docker-desktop-image.sh)
if [[ -n "$(git status --porcelain --untracked-files=all -- "${image_inputs[@]}")" ]]; then
  echo 'Commit cloud desktop image inputs before building a release tag.' >&2
  exit 1
fi
platform=$("${docker_command[@]}" version --format '{{.Server.Os}}/{{.Server.Arch}}')
case "$platform" in
  linux/amd64|linux/arm64) ;;
  *) echo 'The target Docker engine must run Linux on amd64 or arm64.' >&2; exit 1 ;;
esac
if "${docker_command[@]}" image inspect "$image" >/dev/null 2>&1; then
  existing_revision=$("${docker_command[@]}" image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
  existing_platform=$("${docker_command[@]}" image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
  if [[ "$existing_revision" != "$revision" || "$existing_platform" != "$platform" ]]; then
    echo 'Refusing to overwrite a release tag with different source or architecture.' >&2
    exit 1
  fi
else
  "${docker_command[@]}" build --platform "$platform" --pull \
    --build-arg "COKE_DOTS_GIT_REVISION=$revision" \
    --file deploy/linux-desktop/Dockerfile --tag "$image" .
fi
printf 'DOTS_LINUX_DESKTOP_IMAGE=%s\n' "$image"
