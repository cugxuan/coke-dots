# 维护检查与精简建议

检查日期：2026-10-17。静态盘点基线：`8b642ff`，200 个已跟踪文件。覆盖源码、依赖与构建脚本、部署目录、测试、示例和文档；本次重点是冗余与维护成本，不是逐行安全审计或所有外部服务的验收。

## 结论

当前更需要整理模块边界、演示代码与文档，而不是批量删除依赖。已确认一组完全重复的文件和 10 处未使用符号；没有发现可直接认定为无用的顶层 npm 依赖。以下区分可以清理的内容、需要保留行为的重构，以及需要实测的性能建议。

## 可以优先清理

### 1. 未使用的导入与局部变量

在基线上运行 `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`，得到 10 处诊断：

| 文件 | 未使用项 |
| --- | --- |
| `src/web/DotAvatarEditor.tsx` | 默认导入 `React` |
| `src/web/DotOnboarding.tsx` | 默认导入 `React` |
| `src/web/main.tsx` | 局部变量 `active` |
| `tests/cloud-kernel-adapter.test.ts` | 参数 `directory` |
| `tests/e2e/k3d-cloud-computer.e2e.ts` | 类型 `Server` |
| `tests/e2e/ui.e2e.ts` | `accessSync`、`constants`、`readFile`、`encodeVolcengineEvent` |
| `tests/incident-git-credential.test.ts` | `readFile` |

可在小范围清理中去掉这些导入 / 变量，并处理未用参数，再评估启用编译器的 unused 检查。它们是额外静态检查发现的维护问题；当前项目要求的 `npm run build` 通过。本次文档整理未修改这些源码和测试文件。

### 2. 完全重复的演示页面

以下两个文件逐字节相同，各为 9,728 字节：

- [`examples/coke-agent-incident-demo/log-system/index.html`](../examples/coke-agent-incident-demo/log-system/index.html)
- [`public/incident-logs/index.html`](../public/incident-logs/index.html)

建议只维护一个源文件，在需要演示的构建中复制到公开资源目录，并检查复制结果。不能直接删除 `public` 中的版本：当前故障演示的 Agent 提示会打开 `/incident-logs/`，删除会使流程失效。

### 3. 工具缓存与文档入口

本次已将 `.playwright-cli/` 加入 `.gitignore`，避免临时浏览器日志 / 快照进入提交。原有 `data/`、`artifacts/`、构建目录和研究视频 / 帧图已被忽略，不是 Git 仓库中的冗余文件。

README 已从开发记录整理为项目介绍和快速开始，配置与测试细节分别放入[配置指南](configuration.md)和[贡献指南](../CONTRIBUTING.md)。原文档中已过时的“只有显式工作区笔记”描述改为区分工作区笔记与个人 Dot 记忆。

钉钉连接器文档中“Agent 文档 bridge 尚待实现”的旧描述也已修正；现有实现提供受 tenant / user / task 约束的文档搜索、读取、新建与日历读取授权，不包含 Agent 文档更新能力。

Kubernetes 部署文档同步修正了镜像内的 Pi 安装状态、接管后的任务暂停状态和服务重启后的重新排队行为；重新排队不等于外部操作可以无条件重放。

## 应按功能逐步拆分

### 4. 入口与数据库文件承担过多职责

| 文件 | 基线行数 | 建议拆分方向 |
| --- | ---: | --- |
| `src/server/store.ts` | 1,424 | schema / migration、账号与工作区、任务、页面与记忆、集成事件 |
| `src/server/index.ts` | 1,060 | 认证、工作区、任务、模型、电脑、连接器路由；统一保留认证和 Origin 校验 |
| `src/web/main.tsx` | 915 | App shell、会话状态、聊天、Activity、设置与成员管理 |
| `deploy/dingtalk-connector/gateway.mjs` | 1,236 | 身份票据、授权、文档 / 日历、事件流和错误处理 |

部分源码行很长，行数只用于定位，不代表复杂度的精确度量。按一个领域一次拆分，保留现有对外协议和测试，再消除跨模块重复。

### 5. 固定演示场景进入通用业务逻辑

`src/server/store.ts` 的 `dingtalkIncidentProfile` / `dingtalkAlertInstruction` 固定了群名、服务名、Trace ID、演示 URL 和目标 Git 仓库；`worker.ts`、桌面适配器与 Git credential broker 也识别这一场景。

建议把场景定义放到 `examples/` 或明确的演示 profile 中，通用事件处理只依赖一个有类型的场景接口。保留现在的精确匹配、显式启用和固定仓库凭据范围，不应为了配置化而允许任意仓库或 URL。迁移时同时验证演示仍可运行、普通告警不会进入修复流程。

### 6. 样式覆盖层较多

`src/web` 有 23 个 CSS 文件。`style.css`、`shell-replica.css`、`mobile-replica.css`、主题与通话样式依赖导入顺序；例如 `.shell`、`.top-actions` 分散在多个文件中。基线构建输出 CSS 约 141.25 kB，gzip 后约 27.55 kB。

建议先格式化压成单行的源样式，再按组件和主题变量合并规则。重复选择器也可能是正确的响应式 / 主题覆盖，不能按文本匹配批量删除。需比较桌面、移动端、深浅主题和当前紧凑通话卡片，再判断哪些旧规则可移除。

## 优化前需要补充度量

### 7. 每次推送会重复构建工作区快照

`src/server/index.ts` 的 `publish()` 为每个 SSE 连接调用 `snapshot()`；`Store.snapshot()` 查询该租户的全部任务、监控与最近 150 条记录。同一工作区的多个标签页会重复执行这些查询并传输完整快照。

可以先在一次 `publish()` 内按租户复用快照，继续逐连接检查会话有效性；然后评估任务分页、增量事件和前端选择性更新。先记录不同任务数 / 连接数下的查询耗时和推送体积，目前没有性能压测数据，不能给出加速比例或将其认定为已证实的卡顿原因。

### 8. 安装边界可以更清晰

全量安装同时包含 Web、Electron、连接器和两种可选 Agent SDK。本机 Linux 安装后 `node_modules` 约 614 MiB，其中 Electron 约 288 MiB；这些是环境相关的磁盘测量，不是仓库体积或网络下载量。

桌面镜像又复用了根 `package.json` 的生产依赖，包含只在控制面 / Web 使用的包。后续可按控制面、桌面外壳和云电脑 runtime 拆分安装清单或 npm workspaces，分别保留锁文件一致性与镜像导入检查。

目前所有顶层依赖都能对应到源码、脚本、类型或构建用途。`playwright-core` 用于真实浏览器运行，`typebox` 用于云电脑适配器，不能因为 Web 代码没有导入就删除。`private: true` 防止误发布 npm 包，不妨碍源码协作；`package-lock.json` 应保留。

本次 `npm ci` 也报告了部分 Pi 包的 deprecated 提示。应单独核实替代包的 API、原生会话与镜像兼容性后迁移，不宜在文档整理中直接改包名或批量升级。

### 9. 测试与运行版本声明

主 UI E2E 在基线有 3,502 行，覆盖大量领域，建议按登录 / 工作区、任务、连接器、电脑、语音拆分场景并复用 fixture。拆分时保留跨领域路径，避免每个小测试重复启动昂贵的运行环境。

`tsconfig.json` 当前只包含 `src`、`tests` 和 `vite.config.ts`；`electron/` 与 TypeScript 脚本不在这次类型检查内，部署 `.mjs` 主要依赖现有行为测试。可以补充独立类型检查，并增加 Linux CI 来验证文档支持的平台。`package.json` 还应补上与 README 一致的 Node.js `engines` 声明。

## 开源发布还需明确

- 仓库没有 `LICENSE`。README 如实标明待维护者选择，本次没有代选许可证或添加不实的 License badge。
- `AGENTS.md` 含维护者 Mac 的绝对路径，普通贡献者无法读取。后续可把通用贡献规则与本机部署记忆分开；本次保留既有操作约定。
- `research/` 是设计来源与历史记录，`examples/` 中的故障样例故意保留失败测试。两者不应作为“无用代码”整体删除；优先整理索引、标注已被新记录取代的结论。

建议顺序：清理未使用符号和重复演示源文件 → 分离演示 profile → 按领域拆分大文件与 E2E → 在视觉回归保护下合并 CSS → 根据度量优化 SSE 和安装边界。

## 本次验证范围

- Linux / Node.js 24.22.0，独立工作目录使用 `npm ci` 安装；同步到主线 `a7ce8fd` 后重新构建并运行单元测试：193 项中 189 项通过，4 项 macOS 专用检查跳过，0 失败。
- 检查 36 个本地 Markdown 链接及锚点、12 个文档引用的 npm script；`git diff --check` 通过。
- 隔离的本地 Chrome 实例完成访问密钥登录、打开模型设置、保存测试配置，确认文件存储模式、模型引擎可用以及凭据目录 / 文件权限为 `0700` / `0600`。模型地址使用保留的 `.invalid` 测试域名，没有调用真实提供商。
- 未运行完整 UI / 云电脑 E2E、真实 Google OAuth、外部 Debian / Kubernetes、真实模型或语音验收，也未进行匿名公网或登录后的公网检查。本次没有部署运行时变更。
