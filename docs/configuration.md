# 配置指南

首次运行请从 [README 的快速开始](../README.md#快速开始) 开始。本文补充可选功能和部署配置；完整的基础配置模板见 [`.env.example`](../.env.example)。

## 环境与数据

服务端默认读取工作目录中的 `.env`；可通过 `DOTS_ENV_FILE` 指定另一份私有环境文件。已有的进程环境变量优先于文件中的同名值。Node.js 24+ 是控制面的运行要求，桌面容器使用其 Dockerfile 固定的 Node.js 版本。

| 配置 | 用途 |
| --- | --- |
| `DOTS_PORT` | API 与构建后页面的端口，默认 `4317` |
| `DOTS_DATA_DIR` | SQLite、本地工作区和相关状态目录，默认 `./data` |
| `DOTS_AUTH_MODE` | `google`（默认）或单用户 `local` |
| `DOTS_MODEL_SECRET_BACKEND` | 模型凭据存储：`file` 或 `kubernetes` |
| `DOTS_COMPUTER_BACKEND` | 未设置时使用本地浏览器；`ssh-docker` / `linux-desktop` 使用独立 Debian 桌面 |
| `DOTS_CHROME_BIN` | 使用本地浏览器或运行浏览器测试时，指定 Chrome 可执行文件 |

默认 Chrome 路径面向 macOS。Linux 使用本地浏览器时，应将 `DOTS_CHROME_BIN` 设为实际的 Chrome / Chromium 路径；模型 API 文本任务本身不需要 Chrome。

Worker 随服务端运行。关闭网页不会结束任务，停止服务端则会停止调度；重新启动时 Worker 会恢复处理遗留的 `working` 任务。云电脑的文件、浏览器状态和原生 Agent 会话还依赖对应的持久卷，具体恢复边界见各部署指南。

## 登录与工作区

### 本地访问密钥

设置 `DOTS_AUTH_MODE=local` 和 32–256 字符的随机 ASCII `DOTS_LOCAL_AUTH_TOKEN`。使用 `openssl rand -hex 32` 生成密钥，不要使用示例占位符作为真实密钥。

本地模式提供一个持久的管理员身份，适合单人部署。更换访问密钥不改变已有工作区，也不会撤销已经签发的会话；退出登录会撤销当前会话。LAN / 公网访问还需要配置网络边界，见 [Debian 部署指南](debian-ssh-docker.md#local-administrator-login-without-google)。

### Google OAuth

需要多用户登录时，注册 Google OAuth Web 客户端，在 `.env` 中设置：

```dotenv
DOTS_AUTH_MODE=google
GOOGLE_CLIENT_ID=<客户端 ID>
GOOGLE_CLIENT_SECRET=<客户端密钥>
GOOGLE_REDIRECT_URI=http://127.0.0.1:4317/auth/google/callback
```

在 Google 配置中登记完全相同的回调 URI。登录只请求 OpenID Connect 身份、email 和 profile，不会因此获得 Gmail 或 Google Drive 访问权限。

首个登录账号会接管尚未被认领的本地工作区；之后的账号各有个人工作区。所有者或管理员可按已验证的邮箱发出邀请，被邀请者需登录并在七天内接受。项目不发送邀请邮件，需要邀请者自行通知对方。

会话使用 HttpOnly cookie。工作区成员关系在请求时检查；移除成员会撤销其在该工作区的会话。

## 共享模型配置

在 **你的 dot 设置 → 共享模型 API** 中保存服务地址、模型名称和 API Key。所有工作区共享这一份配置；首次保存的工作区成为模型管理员工作区，此后仅该工作区的所有者或管理员可修改。

- 地址与模型名称保存在实例 SQLite 设置中；`DOTS_MODEL_BASE_URL` 和 `DOTS_MODEL` 可提供初始值。
- `ssh-docker` 默认使用文件凭据存储，其他模式默认使用 Kubernetes Secret。本地快速开始应显式设置 `DOTS_MODEL_SECRET_BACKEND=file`。
- 文件模式默认写入 `DOTS_DATA_DIR/secrets/model-api-key`；目录要求 `0700`、文件要求 `0600`。可通过 `DOTS_MODEL_SECRET_FILE` 指定其他专用路径。
- Kubernetes 模式默认使用 `coke-dots-system/shared-model-api` Secret，需要对应集群访问权限。
- 切换存储后端不会自动迁移密钥，需要在设置中重新保存。`DOTS_MODEL_API_KEY` 只在 `NODE_ENV=test` 且 `DOTS_E2E_AUTH=1` 的隔离测试环境生效。

云电脑会通过经过认证的 Agent 请求收到本次任务所需的模型配置。模型地址必须能从桌面容器访问；容器内的 `127.0.0.1` 指向容器自身。

## Agent 引擎

### 模型 API

使用共享模型配置调用兼容 Chat Completions 的服务。该适配器没有浏览器或终端工具，可以返回结构化任务决策和受规则约束的 Scratchpad 页面操作。

### Pi

Pi SDK 已列为可选依赖。设置 `DOTS_PI_ENABLED=1` 启用；若安装时跳过了可选依赖，需要补装 `@mariozechner/pi-coding-agent`。

本地适配器使用 Pi 自身配置的模型凭据和只读工具，会话保存在任务工作目录的 `.coke-dots/pi-sessions` 下。

云电脑适配器使用实例共享模型配置，在租户 Debian 桌面的 `/workspace/tasks/<task-id>` 中工作，提供 Pi 编码工具与 Browser Use。使用 [SSH Docker](debian-ssh-docker.md) 或 [Kubernetes](linux-cloud-desktop.md) 部署指南启用这一模式。用户接管桌面时，Agent 的电脑操作受到控制权约束。

### DeepSeek Harness

可选依赖为 `@deepseek-ai/dsh-sdk-client`。本地适配器需要 `DOTS_DSH_BIN` 和经过核实的只读配置 `DOTS_DSH_READ_ONLY_CONFIG`；云电脑内的可用性取决于镜像安装的 runtime 与 kernel 配置。不要根据一个 SDK 的安装成功推断所有工具已可用。

Claude Code 不是可选引擎。旧任务记录中的 Claude 标识保留用于历史兼容，不能用于创建新任务。

## 语音与连接器

`DOTS_VOICE_PROVIDER` 可选 `browser`（默认）、`qwen` 或 `volcengine`。浏览器模式依赖浏览器的语音能力；外部实时语音需要相应服务凭据、服务开通状态和麦克风权限。麦克风功能需要安全上下文（HTTPS 或 localhost）。

Qwen 使用 `DOTS_QWEN_API_KEY`、`DOTS_QWEN_WORKSPACE_ID` 和 `DOTS_QWEN_REGION`（默认 `beijing`）。`DOTS_QWEN_MODEL` 支持默认的 `qwen3.8-omni-flash-realtime` 或 `qwen-audio-3.0-realtime-plus`；应用按型号选择音色和转写参数。Token Plan 设置工作空间为 `token-plan`，语音模型为 `qwen-audio-3.0-realtime-plus`。修改语音环境变量后重启控制平面。API Key 始终留在服务端，浏览器通过应用接口交换 WebRTC SDP。

火山引擎的 `DOTS_VOLCENGINE_API_KEY` 选择 SeedDuplex JSON 协议；旧协议使用 `DOTS_VOLCENGINE_APP_ID` 和 `DOTS_VOLCENGINE_ACCESS_TOKEN`。这些是服务端实例凭据，不能放进前端变量。保存了凭据不代表提供商已开通实时语音权限。

Slack 需要单独的 OAuth App 配置。钉钉包含独立 DWS 连接器和 Stream 集成，详见[连接器说明](../deploy/dingtalk-connector/README.md)。普通登录和模型配置不会自动授予这些外部账号的访问权限。

## 反向代理与子路径

根路径的 HTTPS 部署见 [HTTPS domain access](debian-ssh-docker.md#https-domain-access)。如果挂载到 `/dots-demo`，构建资源路径和服务端配置需要一致。

构建前端：

```sh
DOTS_PUBLIC_BASE_PATH=/dots-demo/ npm run build
```

设置服务端环境：

```dotenv
DOTS_BASE_PATH=/dots-demo
DOTS_APP_URL=https://dots.example.com/dots-demo
DOTS_PUBLIC_ORIGIN=https://dots.example.com
GOOGLE_REDIRECT_URI=https://dots.example.com/dots-demo/auth/google/callback
DOTS_TRUSTED_PROXY_TOKEN=<另一枚独立随机密钥>
```

Google 登录时需登记上述回调；访问密钥登录保留 `DOTS_AUTH_MODE=local` 及其密钥即可。默认 token 代理模式要求反向代理从 loopback 连接，保留公开 Host，并覆盖 `X-Dots-Proxy-Token` 为配置的代理密钥。保留 `/dots-demo` 前缀，支持 WebSocket 升级，并关闭 SSE 响应缓冲。

只在已经确认可信的本地隧道场景使用 `DOTS_TRUSTED_PROXY_MODE=loopback`，其约束见部署指南。`npm run build:demo` 是 `/dots-demo/` 路径且默认选择 Pi 的构建快捷方式；它不安装或部署 API、连接器与桌面镜像。

## Electron 桌面外壳

默认 `npm ci` 会安装 Electron 二进制。仅运行 Web 服务可使用 `npm run install:web` 跳过该下载；切换到桌面开发前运行 `npm run install:desktop` 补装。轻量安装仍保留所有其他依赖和可选 Agent SDK。

macOS 上运行 `npm run desktop` 会构建前端、服务端与 Electron 外壳，按需启动独立的本地服务。关闭窗口后服务仍会运行。开发时可使用 `npm run dev:desktop`。

这是开发构建，不是签名安装包。仍需 Node.js 24 和前述登录配置。Electron 自行启动服务时，未指定 `DOTS_DATA_DIR` 会使用 Electron 用户数据目录；复用已有服务时则使用该服务的数据目录。
