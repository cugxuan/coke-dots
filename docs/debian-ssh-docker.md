# Debian single-host deployment over SSH

`DOTS_COMPUTER_BACKEND=ssh-docker` runs each workspace's existing Debian desktop image in an independent Docker container, network and persistent volume on one SSH-accessible host. It does not call `kubectl`, create Kubernetes resources, or require K3d. `linux-desktop` continues to select the existing Kubernetes backend.

The Coke Dots control plane can run on your own computer or on the Debian server. It serves the web UI, owns Google login, SQLite, task scheduling and the shared model credential. The remote desktop contains Chromium, XFCE, noVNC, the browser Worker and the Agent runtime. SSH transports Docker management and forwards the three desktop services; no public Docker API or desktop ports are needed.

## Requirements

- Control plane: Node.js 24+, npm and an OpenSSH client. A Docker CLI is needed for the image-build command below, but is not needed by the running Coke Dots service.
- Remote Debian host: an SSH server and a rootful Docker Engine **28+**, with the Docker CLI installed. The SSH user must be able to access `/var/run/docker.sock` without an interactive password or `sudo` prompt. That account is an operator account; it is never given to a tenant Agent.
- Key-based SSH authentication, a verified entry in `known_hosts`, and permission for local TCP forwarding. Password prompts and agent forwarding are disabled by the application.
- Enough memory and disk for the selected workspaces. Each desktop defaults to a 2 CPU / 4096 MiB limit and a 512-process limit. The host kernel must support Chromium's sandbox under Docker's security profile.
- Google OAuth (or the local administrator login below) and an OpenAI-compatible model endpoint.

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

### Included research tools

The desktop image preinstalls PDF text extraction and rendering (`pdftotext`, `pdfinfo`, `pdftoppm`, Python `pypdf` and `pymupdf`), CSV/Excel processing (`pandas`, `openpyxl`), Word `.docx` processing (`docx`), HTML/XML parsing (`bs4`, `lxml`, `requests`), and shell utilities (`rg`, `jq`, `file`, `zip`, `unzip`, `xxd`). The Pi runtime advertises these tools so routine research uses them directly. The Debian PyMuPDF package uses `import pymupdf`; its legacy `fitz` import is not installed.

`python3` and `pip` use `/opt/coke-dots/python`, a non-root virtual environment with the preinstalled system libraries. Supplementary packages can be installed there when needed. npm and pip caches live in `/workspace/.cache/npm` and `/workspace/.cache/pip`, outside task deliverables; recreating a desktop with an older root-owned `~/.npm` does not select that cache. Existing user files and cache ownership are preserved.

After building, verify real PDF/Chinese text extraction, spreadsheet and Word round trips, HTML parsing, shell tools, and offline dependency installation as the image's non-root user:

```sh
bash scripts/verify-desktop-research-tools.sh coke-dots-linux-desktop:sha-<revision-from-build>
```

The check runs in an isolated disposable container with networking disabled and does not mount any live workspace. It uses the local Docker engine or the command-scoped `DOCKER_HOST` selected for the build. These tools do not provide OCR for scanned documents or access to authenticated external sites.

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
VITE_DOTS_DEFAULT_ENGINE=pi npm run build
NODE_ENV=production npm start
```

Open `http://127.0.0.1:4317`, sign in and save the shared model settings before starting a Pi task. The app defaults to loopback; LAN and HTTPS domain access are described below. For a reverse-proxy subpath, see the [configuration guide](configuration.md#反向代理与子路径). Configure the service manager's working directory, data path and SSH credentials consistently. The controller must be running for task scheduling and browser access.

### Local administrator login without Google

For a single-user control plane on localhost, add these settings to the service's private environment file:

```dotenv
DOTS_AUTH_MODE=local
DOTS_LOCAL_AUTH_TOKEN=<output-of-openssl-rand-hex-32>
```

Restrict the environment file to the service owner (`chmod 600`). The access key is a login credential, separate from both the model API key and the desktop token secret. Enter it in the web login form; it is exchanged for the same HttpOnly session cookie used by Google login. The fixed local administrator retains the same workspace across restarts and access-key changes. Existing sessions last up to 30 days; rotating the login key does not revoke existing sessions. Sign out to revoke a session.

Local mode rejects missing/short keys and public settings without HTTPS and an explicit trusted proxy at startup. For a control plane on another machine, enable LAN or HTTPS domain access below, or use `ssh -N -L 4317:127.0.0.1:4317 user@host` and open `http://127.0.0.1:4317` on your computer. The default `DOTS_AUTH_MODE=google` retains Google OAuth and multi-user invitation login. Do not enable `DOTS_E2E_AUTH` in a deployed service.

In the web app, open **设置 → 共享模型 API**, enter the provider's HTTPS API base URL, model name and key, and save. Use a **Pi** task for actions and files inside the Docker desktop. The endpoint must be reachable from the desktop container: `127.0.0.1` there is the container itself. A configured endpoint that is only listening on the control-plane host's loopback needs an explicit tunnel or proxy accessible to the desktop.

An existing standalone preview container is not automatically adopted: its tokens, labels and volume ownership differ from a managed workspace. For migration, stop writes to the preview, back up its `/workspace`, create the target workspace's labelled volume, copy files preserving ownership, then let the connector create its managed container. Preserve the original volume until the migrated desktop and files have been checked. Never point multiple tenants at one preview volume.

### LAN access

To access the built web UI directly from other devices on a trusted IPv4 LAN, add these settings alongside the local administrator login configuration and restart the control plane:

```dotenv
DOTS_BIND_HOST=0.0.0.0
DOTS_LAN_ORIGIN=http://192.168.1.10:4317
DOTS_LAN_CIDR=192.168.1.0/24
```

Replace the example IP with the control-plane host's actual private address and the CIDR with the permitted client subnet. Open that exact LAN URL and use the existing login key. Loopback access remains available. The request boundary checks the socket's source address, the exact LAN Host/port and browser Origin for HTTP and WebSocket requests. Forwarded IP headers cannot grant access. Only a subnet wholly inside RFC1918 private space is accepted; the origin must be a private IPv4 HTTP URL using `DOTS_PORT`. An all-interface listener without explicit LAN configuration is rejected at startup. To bind only the LAN interface, use its exact IP for `DOTS_BIND_HOST` instead.

Only the control-plane port needs to be reachable through a host firewall. Worker, Agent, noVNC and the dedicated SSH transport continue to use their loopback-only ports. Model settings, task files, desktop viewing and takeover use the authenticated control-plane URL. HTTP LAN access is intended for a trusted network; microphone/WebRTC features that require a secure browser context need HTTPS or localhost. If DHCP changes the server address, update the LAN origin and restart, or reserve a stable address on the router.

### HTTPS domain access

The LAN IP configuration does not allow a domain automatically. Configure the exact HTTPS origin alongside the existing administrator key. Keep TLS termination and HTTP-to-HTTPS redirection at your reverse proxy, forward the original Host, and enable WebSocket upgrades and unbuffered SSE responses.

```dotenv
DOTS_AUTH_MODE=local
DOTS_LOCAL_AUTH_TOKEN=<existing administrator access key>
DOTS_PUBLIC_ORIGIN=https://dots.example.com
DOTS_TRUSTED_PROXY_TOKEN=<a separate random secret generated with openssl rand -hex 32>
```

The default `DOTS_TRUSTED_PROXY_MODE=token` requires the proxy to connect from loopback and overwrite `X-Dots-Proxy-Token` with that separate secret. `DOTS_PUBLIC_HOST` is optional; if set for key login, it must match the origin's hostname.

For an existing trusted TCP tunnel such as FRP that connects to `127.0.0.1:4317` and cannot inject an HTTP token header, explicitly choose this alternative instead of the proxy token:

```dotenv
DOTS_PUBLIC_ORIGIN=https://dots.example.com
DOTS_TRUSTED_PROXY_MODE=loopback
```

This mode trusts the local tunnel: only actual loopback peers, the exact public Host/port and `X-Forwarded-Proto: https` are accepted. The HTTPS proxy must overwrite that header, and its plaintext upstream/tunnel port should be restricted to the proxy. Forwarded client-IP headers cannot grant trust. Browser mutations and WebSocket connections must also use the configured HTTPS Origin. Other LAN clients cannot bypass the boundary by spoofing the public Host or proxy headers.

Restart the controller, open the HTTPS URL, and sign in with the same access key. Public sessions use Secure, HttpOnly, SameSite=Lax cookies; local and LAN HTTP login continue to work with separate host cookies and the same persistent workspace. Keep the LAN settings if both entry points are needed. The existing Google/token-proxy setup remains supported and is the default for multi-user deployments.

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
