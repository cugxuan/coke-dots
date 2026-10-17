# Debian single-host deployment over SSH

`DOTS_COMPUTER_BACKEND=ssh-docker` runs each workspace's existing Debian desktop image in an independent Docker container, network and persistent volume on one SSH-accessible host. It does not call `kubectl`, create Kubernetes resources, or require K3d. `linux-desktop` continues to select the existing Kubernetes backend.

The Coke Dots control plane can run on your own computer or on the Debian server. It serves the web UI, owns Google login, SQLite, task scheduling and the shared model credential. The remote desktop contains Chromium, XFCE, noVNC, the browser Worker and the Agent runtime. SSH transports Docker management and forwards the three desktop services; no public Docker API or desktop ports are needed.

## Requirements

- Control plane: Node.js 24+, npm and an OpenSSH client. A Docker CLI is needed for the image-build command below, but is not needed by the running Coke Dots service.
- Remote Debian host: an SSH server and a rootful Docker Engine **28+**, with the Docker CLI installed. The SSH user must be able to access `/var/run/docker.sock` without an interactive password or `sudo` prompt. That account is an operator account; it is never given to a tenant Agent.
- Key-based SSH authentication, a verified entry in `known_hosts`, and permission for local TCP forwarding. Password prompts and agent forwarding are disabled by the application.
- Enough memory and disk for the selected workspaces. Each desktop defaults to a 2 CPU / 4096 MiB limit and a 512-process limit. The host kernel must support Chromium's sandbox under Docker's security profile.
- Google OAuth and an OpenAI-compatible model endpoint, as in the main README.

Docker 28+ is required because older Docker releases could expose localhost-published ports to machines on the same L2 network. See [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/) and [Docker over SSH](https://docs.docker.com/engine/security/protect-access/).

## 1. Prepare SSH access

Use an SSH alias in the control-plane service user's `~/.ssh/config`, for example:

```sshconfig
Host dots-debian
    HostName your-debian-host
    User dots-operator
    Port 22
    IdentityFile ~/.ssh/dots-debian
    IdentitiesOnly yes
    StrictHostKeyChecking yes
```

Verify the host fingerprint through your usual trusted channel and populate that user's `known_hosts`. Check the connection and Docker permissions:

```sh
ssh -o BatchMode=yes dots-debian docker version
```

The application supports `DOTS_DOCKER_SSH_PORT`, `DOTS_DOCKER_SSH_IDENTITY_FILE` and `DOTS_DOCKER_SSH_KNOWN_HOSTS_FILE` overrides. Otherwise it respects the SSH alias configuration, including its port. Use absolute file paths for a background service. An encrypted private key requires an already-unlocked local ssh-agent; the agent is not forwarded to Debian.

## 2. Build the desktop image on Debian

From a clean checkout with committed image inputs, install the control-plane dependencies and build the image on the remote Docker engine:

```sh
npm ci --include=dev
DOCKER_HOST=ssh://dots-debian npm run build:docker-desktop-image
```

The build detects the remote architecture, embeds the Git revision and prints:

```dotenv
DOTS_LINUX_DESKTOP_IMAGE=coke-dots-linux-desktop:sha-<40-character-git-revision>
```

No cluster or image import is involved. The Docker build context is restricted by `.dockerignore`; local credentials, SQLite, task files and browser profiles are excluded. The build uses the remote Docker engine's network access to fetch Debian and npm dependencies.

Alternatively, build/load/pull the same image onto the target host yourself and set its reference. The runtime requires the image to be installed before opening a desktop; it does not pull or rebuild images in response to user tasks. Production accepts a `sha-<40-character-revision>` tag or a registry reference pinned with `@sha256:<digest>`.

## 3. Configure the control plane

Copy `.env.example` to `.env` if it does not already exist. Fill Google OAuth as usual and set:

```dotenv
DOTS_COMPUTER_BACKEND=ssh-docker
DOTS_DOCKER_SSH_HOST=dots-debian
DOTS_DOCKER_INSTANCE_ID=my-dots
DOTS_LINUX_DESKTOP_IMAGE=coke-dots-linux-desktop:sha-<revision-from-build>
DOTS_LINUX_DESKTOP_TOKEN_SECRET=<at-least-32-random-characters>
DOTS_PI_ENABLED=1
DOTS_DATA_DIR=./data
DOTS_MODEL_SECRET_BACKEND=file
# Optional limits per workspace:
DOTS_DOCKER_CPUS=2
DOTS_DOCKER_MEMORY_MB=4096
```

Generate the token secret locally, for example with `openssl rand -hex 32`. Keep the instance ID and token secret stable across restarts, and use a distinct instance ID for each control plane sharing a Docker host. Do not commit credentials. `DOTS_LINUX_DESKTOP_PROXY_BRIDGE` must be unset or `0`: that bridge is specific to the existing Mac/Docker Desktop setup.

For local development run `npm run dev` and open `http://127.0.0.1:5173`. For a built service:

```sh
npm run build
NODE_ENV=production npm start
```

Open `http://127.0.0.1:4317`, sign in and save the shared model settings before starting a Pi task. The app continues to bind to loopback; public HTTPS/reverse-proxy configuration is the same as the main README. Configure the service manager's working directory, data path and SSH credentials consistently. The controller must be running for task scheduling and browser access.

## Model credential storage without Kubernetes

SSH Docker mode defaults to `DOTS_MODEL_SECRET_BACKEND=file`. Other existing modes default to `kubernetes`; an explicit value selects the backend in either mode. Invalid backend names fail rather than silently falling back.

In file mode, the model settings UI writes the key to `DOTS_DATA_DIR/secrets/model-api-key` on the **control-plane machine**. `DOTS_MODEL_SECRET_FILE` can select a different dedicated path. The directory must belong to the service user with mode `0700`; the file is plaintext with mode `0600`. New files are written atomically. Publicly readable files, symlink targets and hard-linked files are refused. Model metadata and administrator ownership remain in the instance SQLite database, and all workspaces still use the same model configuration.

The key is never copied to tenant volumes, container environment variables or browser responses. It is delivered only in the authenticated Agent task request over the SSH tunnel. Changing the storage backend does not migrate credentials automatically: save the key again in settings. `DOTS_MODEL_API_KEY` remains a test-fixture setting and is not a production bootstrap mechanism.

Back up the control-plane database, private credential file, stable instance configuration and the remote tenant volumes. Protect backups with the same access controls as the originals.

## Isolation and lifecycle

- Each workspace has a deterministic `dots-<instance>-<tenant-hash>` container, a dedicated bridge network and a dedicated Docker volume mounted at `/workspace`. Runtime tokens are distinct per workspace and per service. Tasks retain `/workspace/tasks/<task-id>` boundaries and their native Agent sessions.
- Only noVNC 6080, Worker 8082 and Agent 8083 are published, on randomly allocated **remote loopback** ports. SSH forwards them to randomly allocated control-plane loopback ports. Raw VNC 5900 and Chromium CDP 9222 are not published. Browser users continue through the authenticated Coke Dots API.
- Containers run as UID/GID 1000 without privileged mode, host networking, host filesystem mounts, a Docker socket or forwarded SSH credentials. Networks and volumes must carry the exact instance/workspace ownership labels; a same-name resource belonging to someone else causes an error.
- Closing a browser or SSH connection does not delete the container or volume. A stopped owned container can be restarted, and a removed container can be recreated using its retained volume. Broken SSH tunnels reconnect; a browser write operation is never automatically replayed after an ambiguous transport failure.
- Changing the image, tokens or container limits does **not** automatically remove a working desktop. End that workspace's active tasks, stop the control plane, verify the exact container's labels, then remove only that container with `docker rm -f <exact-owned-container-name>` (without `-v`). Keep its volume and network. Restart the control plane and reopen the desktop to create the new container against the existing volume. Never use a global prune/reset command.
- This backend does not provision cloud machines, implement host failover, enforce per-volume disk quotas or garbage-collect tenant data. Docker bridge/firewall configuration must retain tenant network separation. The existing Kubernetes incident-remediation Git credential sidecar is not provisioned by this backend; enabling that special profile is rejected explicitly.

## Verification

`npm test` includes ownership, secret persistence, SSH transport, network/port isolation, restart/reconnect and refusal-path coverage. `npm run test:e2e:cloud-computer` checks the shared authenticated browser/Agent flow against isolated mock runtimes; it does not prove that a Debian host or real Docker desktop starts.

On a Linux development machine with Docker Engine 28+, `sshd`, `ssh-keygen` and `ldd`, run `npm run test:e2e:ssh-docker` for the real SSH/Docker transport test. The current user must be permitted to start a temporary loopback `sshd` and use the local Docker socket. The harness creates temporary SSH keys, an isolated SSH server and labelled test resources; it removes only those resources afterward. It builds a small fixture image from the local Node binary without pulling an image. The original Agent runtime executes a test adapter, while the browser Worker and noVNC endpoints are fixtures. It verifies two tenants, shared file credentials, task dispatch, artifact access, takeover and session/data persistence after control-plane restart and container recreation. It does not exercise the full XFCE/Chromium image or a real model provider.

Before releasing on a real Debian host, verify Google login, saving/reloading the shared model key without `kubectl`, two isolated workspaces, nonblank desktop rendering, browser takeover/return, a real Pi task with file output, and volume/session persistence after a scoped container recreation. Check both HTTP and noVNC WebSocket access. The Docker image, control-plane code and served frontend must be deployed from compatible revisions.

## Keep or restore Kubernetes mode

Use `DOTS_COMPUTER_BACKEND=linux-desktop` and `DOTS_MODEL_SECRET_BACKEND=kubernetes` with the existing kubeconfig and cluster image settings. The original `build:linux-desktop-image` and K3d tests are unchanged. Switching modes leaves both backends' resources intact; it does not move workspace files between Docker volumes and Kubernetes PVCs. End active work before switching.
