# Coke Dots

一个可自托管的个人 Agent 工作台，把对话、持续任务、定时自动化和独立云电脑放在一起。

[快速开始](#快速开始) · [配置指南](docs/configuration.md) · [部署](#部署) · [参与贡献](CONTRIBUTING.md) · [报告问题](https://github.com/cugxuan/coke-dots/issues)

Coke Dots 使用 React、TypeScript、Node.js 和 SQLite 构建。任务由服务端 Worker 执行，关闭网页后仍可继续；需要浏览器和文件操作时，可以接入按工作区隔离的 Debian 云电脑。

项目目前处于早期开发阶段，接口和部署方式可能调整。它是受 Dots 启发的独立项目，与 OpenAI 无隶属关系。

## 主要功能

- **持续任务**：查看进度、补充指令、暂停或停止任务；支持一层、最多三个子任务的委派。
- **定时自动化**：按间隔、每天或每周运行，管理时区、执行记录和网页监控。
- **云电脑**：在 Debian 桌面中运行 Pi Agent，使用 Chromium、读写任务文件、预览产物，并随时接管或交还控制权。
- **工作区协作**：Google 登录、工作区邀请与角色管理；任务、文件和浏览器会话按工作区隔离。单人部署也支持访问密钥登录。
- **知识与审批**：Scratchpad 页面、工作区笔记、个人 Dot 记忆，以及页面写入规则和审批。
- **扩展能力**：可配置的语音通话、Slack 和钉钉集成；这些功能需要各自的服务配置和授权。

## 快速开始

下面的流程启动单用户 Web 版，使用本地访问密钥和文件形式的模型凭据存储，无需 Google OAuth 或 Kubernetes。

### 1. 安装

准备 **Node.js 24+**、npm 和 Git。以下命令适用于 macOS / Linux：

```sh
git clone https://github.com/cugxuan/coke-dots.git
cd coke-dots
npm ci
cp .env.example .env
chmod 600 .env
```

仅使用 Web 版时，可把 `npm ci` 替换为 `npm run install:web`，跳过 Electron 二进制下载；以后需要桌面外壳时运行 `npm run install:desktop` 补装。两种方式使用同一份锁文件，保留 Agent SDK 和 Web 所需依赖。

### 2. 配置登录

生成一枚访问密钥：

```sh
openssl rand -hex 32
```

编辑 `.env`，加入以下配置，并用上一步的输出替换占位符：

```dotenv
DOTS_AUTH_MODE=local
DOTS_LOCAL_AUTH_TOKEN=<粘贴生成的访问密钥>
DOTS_MODEL_SECRET_BACKEND=file
```

访问密钥用于登录 Coke Dots，与模型服务的 API Key 是两个不同的凭据。`.env` 和运行数据已加入 Git 忽略规则。

### 3. 启动

```sh
npm run build
npm start
```

打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)，输入访问密钥。开发时可改用 `npm run dev`，页面地址为 [http://127.0.0.1:5173](http://127.0.0.1:5173)。

页面使用独立地址：`/chat`（Dot 对话）、`/activity`、`/scheduled`、`/pages`（Scratchpad）、`/computer` 和 `/settings`。任务地址为 `/chat/:taskId`，文档地址为 `/pages/:pageId`；定时任务和监控详情也有独立地址。刷新、浏览器前进后退、复制链接到新标签页或登录后返回，都会恢复对应页面。

这些地址沿用部署前缀，例如 `/dots-demo/activity`。链接只读取当前登录工作区内的数据；切换工作区时会清除原工作区的任务和文档选择。反向代理需要把页面路径转发给 Coke Dots 服务，由服务返回应用入口。

### 4. 连接模型

登录后点击左侧的 **你的 dot 设置**（或账户头像），找到 **共享模型 API**，填写支持 Chat Completions 的模型服务地址、模型名称和 API Key，保存后选择 **模型 API** 创建任务。

模型 API 模式提供文本推理，不直接执行浏览器、终端或文件操作。需要这些能力时，继续配置下方的 **SSH + Docker 云电脑** 和 Pi。

模型配置在整个实例内共享，首次保存配置的工作区成为模型管理员工作区。普通运行应在页面中保存 API Key；`.env.example` 中的 `DOTS_MODEL_API_KEY` 仅供隔离测试使用。

## 部署

| 方式 | 适用场景 | 入口 |
| --- | --- | --- |
| 本地 Web | 单人使用、开发、模型 API 任务 | 上面的快速开始 |
| SSH + Docker | 在一台 Debian 主机运行独立桌面和 Agent | [部署指南](docs/debian-ssh-docker.md) |
| Kubernetes / K3d | 使用已有集群运行租户桌面 | [部署指南](docs/linux-cloud-desktop.md) |
| macOS Electron | 本地桌面开发外壳，尚无签名安装包 | [桌面运行说明](docs/configuration.md#electron-桌面外壳) |

局域网访问和公网 HTTPS 需要显式配置，见 [LAN](docs/debian-ssh-docker.md#lan-access)、[HTTPS 域名](docs/debian-ssh-docker.md#https-domain-access)及[子路径部署](docs/configuration.md#反向代理与子路径)。

## Agent 引擎

| 引擎 | 能力与前提 |
| --- | --- |
| 模型 API | 使用实例共享的 Chat Completions 配置；不带执行工具 |
| Pi | 可选 SDK；本地适配器使用只读工具，云电脑适配器提供终端、文件和浏览器操作 |
| DeepSeek Harness | 可选 SDK / runtime；需显式配置，工具能力取决于所用适配器与 profile |

任务会保留引擎选择和可用的原生会话 ID。缺少配置、引擎不可用或执行失败时会显示失败，不会用模拟结果代替真实执行。具体配置见[配置指南](docs/configuration.md#agent-引擎)。

在 Dot 主聊天发送消息后，会留在原对话中显示任务进度和结果；点击“任务详情”才进入独立任务。Pi 的执行卡展示公开的执行说明、工具调用、有限长度的参数与输出、耗时，以及模型实际返回的本轮和已记录累计 token（输入包含缓存）。这些记录按租户、任务和执行轮次持久化，刷新后仍可查看。不会展示私有思维链，也不会把缺失用量当作零或按未配置的价格估算费用。旧任务与尚未上报用量的内核会明确显示“本轮用量未提供”。

云电脑任务生成的表格、报告等文件会直接显示在主对话中，点击 **下载到本机** 即可按原格式保存到自己的电脑；任务详情也保留文件入口。暂停或失败的任务已生成的文件仍可下载，同一任务继续执行后会更新文件列表。

文件列表优先展示结果中提到的文件，并排除 `node_modules` 和 Python 缓存目录。Qwen 通话中说“下载刚才的结果”或“应该看哪个文件”，会查询本次通话的任务文件并打开下载入口，无需重新执行任务。

升级执行进度功能时，需要同时更新前端、控制端和云电脑镜像。控制端兼容旧镜像的最终 JSON 响应，但旧镜像不会提供实时 Pi 步骤和用量。

云电脑里的 Pi 使用 `browser_execute` 批量操作现有 Chromium：Browser Use Pi 提供任务内持久 JavaScript、CDP 和可取消的执行进程，Playwright 提供元素等待与输入；Pi 仍是唯一的模型决策循环。工具返回可操作元素 ID 和最新页面状态，支持标签页打开、切换和批量关闭。关闭全部页面会保留空白页以维持 Chromium 进程；任务结束保留标签页与登录态。用户接管会取消执行，恢复后重新观察页面，失败的动作不会自动重放。固定上游版本与构建说明见 [vendor/README.md](vendor/README.md)。

当前 Ark DeepSeek V4.1 与受支持的 DeepSeek profile 默认向服务发送 `thinking: disabled`。Agent 可以用任务内的 `set_reasoning` 开启复杂分析，再切回快速执行；不改变实例共享模型设置或其他任务。未知服务不接收猜测的供应商参数。旧工具输出只在模型上下文中缩短，完整 Pi 会话和浏览器输出仍保存在任务目录；持续执行期间对工具上下文限长；轮次结束或续跑前，上下文超过约 32k tokens 时由 Pi 整理，保留近期工作。整理完成后再结束会话，其模型用量也计入统计。

执行卡的耗时明细区分连接、排队、启动、模型响应和工具执行，并显示模型轮次。模型响应包括服务端与网络等待；浏览器耗时是工具耗时的子集，导航与显式等待又是浏览器耗时的子集，不应相加。控制端与 Agent 通过 NDJSON 流及心跳维持长连接；单次实际执行上限为 20 分钟，控制端请求上限为 21 分钟，超时不会被当成完成，中间文件和会话保留。

浏览器回归运行 `npm run test:e2e:browser-agent`（需要 Playwright Chromium，或通过 `DOTS_TEST_CHROME` 指定可执行文件）。`npm run test:agent-long-task` 使用隔离的本地 runtime 真正运行 310 秒，同时验证旧请求的默认响应头超时和新流式请求完成；不访问真实租户或模型服务。

## 项目结构

```text
src/web/                    React 界面
src/server/                 HTTP API、认证、SQLite、任务调度与集成
src/shared/                 共享类型和领域逻辑
deploy/linux-desktop/       Debian 桌面、浏览器 Worker 与 Agent runtime
deploy/dingtalk-connector/  独立钉钉连接器
electron/                   Electron 桌面外壳
tests/                      单元测试和浏览器 / 运行时集成测试
scripts/                    构建、测试与研究工具
docs/                       配置、部署和维护文档
examples/                   演示场景与样例
research/                   参考行为、设计依据与历史验证记录
```

## 开发与测试

```sh
npm run dev       # API :4317 + Vite :5173
npm run build     # TypeScript 检查 + 前端构建
npm test          # 隔离的单元测试
npm run test:e2e  # Chrome UI + 模拟云电脑流程
```

浏览器测试需要安装 Chrome；非默认安装路径通过 `DOTS_CHROME_BIN` 指定。完整命令、平台要求和验证范围见[贡献指南](CONTRIBUTING.md#测试)。

欢迎通过 [Issue](https://github.com/cugxuan/coke-dots/issues) 报告可复现的问题、提出改进建议，或提交小范围的 Pull Request。开始前请阅读[贡献指南](CONTRIBUTING.md)。

## 数据与当前边界

- 默认数据目录为 `./data`，包含 SQLite 和本地工作区数据；云电脑文件位于对应租户的 Docker volume 或 Kubernetes PVC。升级或迁移前需一并备份相关数据和私有凭据。
- 模型配置与模型凭据是实例级共享配置，任务与会话数据按租户隔离；本地 Pi / Harness 的宿主机凭据也不是每位成员独立一份。
- 自托管不代表离线推理。模型、语音和连接器会按配置访问外部服务。
- 页面审批规则只控制 Scratchpad 写入，不是所有外部操作的统一权限系统；文件附件目前支持有限大小的 UTF-8 文本 / 代码文件。
- 本地测试、模拟服务测试与真实部署验收是不同范围。公开演示的可用性不由本仓库的构建结果保证。

## 更多文档

- [配置指南](docs/configuration.md)：登录、数据、模型、引擎、语音和反向代理。
- [钉钉连接器](deploy/dingtalk-connector/README.md)：独立服务的配置与身份边界。
- [维护检查与精简建议](docs/maintenance-review.md)：已核实的重复内容、结构问题和后续整理顺序。
- [研究与证据记录](research/README.md)：设计来源、历史观察和验证范围。

## 许可证

本项目采用 [MIT License](LICENSE)。允许直接使用、修改、再分发和商业使用；再分发源码或软件副本时需保留版权声明和许可证文本。第三方依赖遵循各自的许可证。
