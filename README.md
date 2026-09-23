# DSH Launcher

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的桌面启动器：自动下载运行环境和 dsh、管理版本与更新、安装和管理插件。界面为中文。

不需要预先安装 Node.js 或 pnpm —— 启动器会下载并校验自己的一份，放在自己的数据目录里，不改动系统环境。

## 功能

- **一键安装**：下载 Node.js LTS（SHA-256 校验）+ pnpm 11 + dsh，全程带进度。
- **版本管理**：`latest` / `next` / `alpha` 三个通道，多个版本并存，随时切换或回滚，可自动检查与下载更新，旧版本按需清理。
- **启动与守护**：启动、停止、重启 `dsh web`；自动捕获 dsh 打印的一次性登录地址并打开浏览器（日志里隐去 token）；端口被占用时自动顺延；退出时让 dsh 优雅收尾，不留孤儿进程。
- **插件管理**：按配置（profile）查看已安装插件，支持 npm 包名、`github:用户/仓库`、本地目录和 `.tgz` 安装；检查与批量更新；启用/停用组合包；卸载；处理 pnpm 11 拦截的构建脚本批准。
- **插件市场**：本地索引 npm 上带 `dsh-plugin` 关键字的全部插件（约 5 千个），自己做召回与排序——中文查询可用、按包名精确查找可用，可按综合/下载量/最近更新排序，可只看组合包、隐藏与当前 dsh 不兼容的插件，并按话题（记忆、主题、MCP、终端…）浏览。安装前显示是否为组合包、兼容性、是否含安装脚本。
- **国内网络友好**：可切换 npmmirror 镜像、配置代理（同时传给 npm、pnpm 和 dsh）。

## 系统要求

- Windows 10/11（已实测）、macOS、Linux（代码已适配，未实测）
- 首次安装需要联网，约 200 MB 磁盘空间（Node.js + pnpm + 一个 dsh 版本）

## 从源码运行

```bash
npm install
npm run dev
```

## 打包

```bash
npm run dist
```

在 `release/` 下产出两个 x64 产物：

| 文件 | 说明 |
|---|---|
| `dsh-launcher-<版本>-setup.exe` | 安装包（NSIS）。当前用户安装，可自选安装目录，带桌面与开始菜单快捷方式；卸载程序会清理干净。 |
| `dsh-launcher-<版本>-portable.exe` | 免安装单文件。双击即用，数据保存在 exe 旁边的 `dsh-launcher-data/` 目录里，适合放 U 盘或非系统盘。 |

两者都约 106 MB（含 Electron 运行时），**未做代码签名**，首次运行时 Windows SmartScreen 会提示“已保护你的电脑”，点“更多信息 → 仍要运行”即可。要去掉提示需要自备代码签名证书并在 `electron-builder.yml` 中配置。

只要解包目录、不生成安装程序：`npm run dist:dir`，输出在 `release/win-unpacked/`。

## 数据目录

| 位置 | 内容 |
|---|---|
| `%LOCALAPPDATA%\dsh-launcher`（macOS: `~/Library/Application Support/dsh-launcher`；Linux: `~/.local/share/dsh-launcher`） | 启动器设置、Node.js、pnpm、各版本 dsh、运行日志 |
| `~/.dsh`（即 `$DSH_HOME`） | dsh 自己的会话、设置、凭据、配置与插件 |

- **免安装版**例外：数据默认就放在 exe 旁边的 `dsh-launcher-data/` 里。
- 想换位置：设置环境变量 `DSH_LAUNCHER_DATA`，或在解包目录里放一个名为 `portable` 的空文件（数据将写入程序目录下的 `data/`）。
- 想让 dsh 用别的目录：在“设置 → 路径”里改 `DSH_HOME`，规则与 dsh 命令行一致。

## 常见问题

**和官方桌面端、社区的 dsh-desktop 有什么区别？** 它们把某个固定版本的 dsh 打包进应用；本启动器不打包 dsh，而是从 npm 安装官方发布的版本，因此可以在通道之间切换、安装历史版本、随时回滚。

**为什么启动后浏览器打开的地址带 `?token=`？** 这是 dsh 自己的一次性登录令牌，用它换取 30 天的 `dsh-auth` cookie。直接访问 `http://127.0.0.1:3080/` 会返回 401。启动器会捕获这个地址，并在日志中把 token 隐去。

**插件装到哪里？** 装进所选配置的目录（`$DSH_HOME/profiles/<配置>`），由 dsh 通过 pnpm 管理。启动器执行的就是 `dsh plugin --profile <配置> add …`，和在终端里手动执行等价，也和 dsh Web 界面的插件页共享同一份状态。

**安装插件为什么慢？** 每次 `pnpm add` 都要完整解析依赖并做一次 pnpm 11 的供应链校验，依赖多的配置一次就要半分钟。启动器会把同一配置下排队中的安装**合并成一次运行**（界面显示为「安装 N 个插件」），所以连点多个插件不会成倍变慢；任务面板会显示当前处于校验、解析还是下载阶段。日志里频繁出现 ETIMEDOUT 说明下载源不稳，可在设置里换源。

**提示"pnpm 拒绝运行依赖的构建脚本"怎么办？** pnpm 11 在有依赖的构建脚本未决时，会让这个配置下的**所有安装都失败**。插件页的提示条给两个选择：「允许构建」表示同意这些包在你的机器上以你的权限执行脚本（不在 agent 沙箱内）；「不运行」表示拒绝执行但照常安装。两者都能解除阻塞，纯 JS 插件选后者通常没有影响。

**插件变更后需要重启吗？** 组合包的启用状态在 dsh 启动时确定，所以安装、卸载、启用、停用之后需要重启 dsh；界面会给出提示和“立即重启”按钮。

## 开发

```bash
npm run dev        # Electron 开发模式
npm run dev:web    # 只跑界面（浏览器打开，使用内置的模拟后端，便于走查 UI）
npm run typecheck  # 主进程 + 渲染进程类型检查
npm test           # 单元测试
npm run test:e2e   # 端到端测试：真实下载、真实 dsh、独立的 DSH_HOME
```

调试辅助（仅未打包运行时有效）：`DSH_LAUNCHER_CAPTURE=<文件.png>` 渲染完成后截图并退出，`DSH_LAUNCHER_ROUTE=#/plugins` 指定页面，`DSH_LAUNCHER_SCRIPT=<文件.js>` 在页面里执行脚本（可调用 `window.launcher`）并打印结果。

重新生成应用图标：`node scripts/make-icon.mjs`。

## 结构

```
src/shared     IPC 契约（类型 + 方法白名单）
src/main/core  纯 Node 核心：下载、安装、profile、插件、进程管理（可单测）
src/main       Electron 外壳：窗口、托盘、IPC、代理、加密
src/preload    contextBridge
src/renderer   React 界面
docs/DESIGN.md 设计文档：dsh 的对接事实、架构、关键机制、安全与已知限制
```

## 许可

MIT。本项目与 DeepSeek 官方无关联。
