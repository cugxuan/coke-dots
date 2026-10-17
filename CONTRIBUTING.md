# 参与贡献

欢迎提交 Bug 报告、文档修正、测试和功能改进。首次运行见 [README](README.md#快速开始)，可选服务见[配置指南](docs/configuration.md)。

## 提交问题

请在 [Issues](https://github.com/cugxuan/coke-dots/issues) 中描述预期行为、实际行为和最短复现步骤，同时附上操作系统、Node.js 版本、提交版本与部署模式。明确问题发生在本地开发、模拟测试还是实际部署中。

提供经过脱敏的日志或截图即可，不要提交 `.env`、API Key、登录密钥、cookie、OAuth code、数据库或租户文件。涉及凭据或访问边界的问题不要在公开 Issue 中附上可利用的秘密信息。

## 修改流程

1. Fork 仓库，或在有写权限的仓库中工作。
2. 获取最新 `main`，检查当前改动和分支，再从最新主线创建一个独立分支；保留已有的无关改动。
3. 一次 Pull Request 聚焦一个问题。行为修改配套必要的回归验证，配置或命令修改同步更新文档。
4. 运行与修改相关的检查，提交清晰的变更说明和实际验证范围。

PR 中请说明：问题是什么、修改后的行为是什么、如何验证，以及哪些真实服务或平台尚未测试。不要把 mock 登录或 HTTP 200 写成公网功能验收。

仓库内 Agent 和维护者的集成、部署约定见 [AGENTS.md](AGENTS.md)。其中的本机运行路径属于维护环境，不是普通贡献者运行项目的前提；外部贡献通过 PR 合入。

## 测试

基础检查：

```sh
npm ci
npm run build
npm test
```

`build` 运行 TypeScript 检查和 Vite 构建。`npm test` 使用 Node.js 测试运行器，并为凭据测试创建临时隔离存储；部分 macOS DWS 测试在其他平台明确跳过。样例 `examples/coke-agent-incident-demo/reference-repo` 包含刻意保留的故障，不属于主项目必须通过的单元测试。

| 命令 | 验证范围 / 前提 |
| --- | --- |
| `npm run test:e2e` | Chrome UI 和模拟云电脑流程；本地测试身份、临时数据库及模拟外部服务 |
| `npm run test:e2e:base-path` | `/dots-demo` 子路径、移动视口与本地 mock OIDC 的重定向 / cookie / 会话流程 |
| `npm run test:e2e:cloud-computer` | 隔离 mock runtime 的桌面、接管、文件和 Agent 流程 |
| `npm run test:e2e:ssh-docker` | Linux 上的真实 SSH / Docker 传输与隔离；需要 Docker Engine 28+、`sshd`、`ssh-keygen`、`ldd` 和相应权限，桌面端点使用 fixture |
| `npm run test:e2e:k3d` | 已准备的 K3d 集群、完整 Debian 桌面镜像与 noVNC；见 [Kubernetes 指南](docs/linux-cloud-desktop.md) |
| `npm run test:live-model` | 使用 `DOTS_LIVE_MODEL_API_KEY` 发起真实模型请求；地址和模型通过 `DOTS_LIVE_MODEL_BASE_URL` / `DOTS_LIVE_MODEL` 指定 |
| `npm run test:live-volcengine-voice` | 真实语音 API 握手与音频返回；需要已开通的服务，不覆盖麦克风与完整 Agent 通话 |

Chrome 测试通过 `DOTS_CHROME_BIN` 指定浏览器。录像编码器可通过以下命令安装：

```sh
npx playwright-core install ffmpeg
```

浏览器证据写入被 Git 忽略的 `artifacts/`。测试身份仅在 `NODE_ENV=test` 且 `DOTS_E2E_AUTH=1` 时启用，仅接受 `@example.test` 账号；不得用于实际部署。真实模型和语音检查会访问外部服务并可能消耗额度，只在对应集成需要验证且具备测试凭据时运行。

现有 [CI](.github/workflows/ci.yml) 在 macOS 上运行单元测试及 `test:e2e`，不包含所有真实云端或外部服务检查。

## 代码与文档约定

- 保持现有 TypeScript strict 与 ESM 风格；共享类型和纯逻辑放在 `src/shared/`。
- 保持 API、Worker、桌面 runtime 和前端的数据契约一致；涉及三者的功能需一起验证。
- 持续保留租户、任务和会话边界，明确实例级共享的模型配置与租户数据的区别。
- 不将演示数据或本地运行凭据混入通用逻辑。研究证据放在 `research/`，操作文档放在 `docs/`。
- README 只保留项目介绍、最短启动路径和入口链接，详细验证记录放到对应文档或本地测试产物中。

## 部署验证

代码合入与部署是两个步骤。生产变更需要检查实际安装的源代码、构建和数据库，保留备份，再部署经过验证的改动。云电脑功能还要确认前端、控制面 API 和桌面镜像版本兼容。

真实浏览器验收需要完成登录后的相关操作，检查 API / Worker 返回和最终页面；本地测试、匿名公网检查和已登录的公网检查分别报告。维护者的具体流程以 [AGENTS.md](AGENTS.md) 为准。
