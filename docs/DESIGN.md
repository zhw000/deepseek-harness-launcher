# DSH Launcher 设计文档

DeepSeek Harness（下称 dsh）的桌面启动器：自动下载运行环境与 dsh、管理版本更新、安装与管理插件。

- 目标平台：Windows 10/11（优先）、macOS、Linux
- 技术栈：Electron + TypeScript + React
- 面向用户：想用 dsh 但不想手动折腾 Node.js / pnpm / npm 源的人

## 1. 背景：dsh 是什么，启动器要对接什么

这些是设计的事实依据，均来自 dsh 官方仓库与实际验证（见 §7）。

| 事实 | 对启动器的含义 |
|---|---|
| dsh 以 npm 包 `@deepseek-ai/dsh` 发布，命令为 `dsh` | 用 npm 安装，可并存多个版本 |
| npm 上有 `latest` / `next` / `alpha` 三个 dist-tag，发布频繁（数天一版） | 提供“更新通道”，并支持回滚 |
| `engines.node` 为 `^22.19.0 || >=24.0.0` | 托管一份满足要求的 Node.js LTS，不依赖用户环境 |
| 插件管理命令 `dsh plugin --profile <名称> <pnpm 参数>` 会转发给 **pnpm**，且要求 `pnpm` 在 PATH 中 | 托管一份 pnpm 11，并通过 shim 注入 PATH |
| 配置（profile）位于 `$DSH_HOME/profiles/<名称>`，含 `package.json`（`dsh.profile.bundles` + 依赖）、`cordis.patch.yml`、`pnpm-workspace.yaml` | 直接读取这些文件即可展示插件清单 |
| 插件即 npm 包：声明 `dsh.bundle.patch` 的包会作为“组合包”加入配置层 | 区分“组合包”与“普通依赖”，并给出提示 |
| 启用/停用 = 增删 `dsh.profile.bundles` 中的条目，依赖保留不变 | 停用插件不必卸载 |
| 写 profile 清单要持有 `package.json.lock`（`wx` 创建、内含 pid） | 启动器使用同一把锁，与 dsh Web 插件页并发安全 |
| pnpm 11 会拦截依赖的构建脚本，把待决包写进 `pnpm-workspace.yaml` 的 `allowBuilds`（值为 `set this to true or false`） | 提供“允许构建并重试”，并明确风险 |
| `dsh web` 启动后打印一次性登录地址 `dsh web: http://127.0.0.1:<端口>/?token=…`；直接访问根路径返回 401 | 必须捕获这行输出作为“就绪”信号，并用它打开浏览器 |
| dsh 监听 SIGTERM 做有界优雅退出（落盘会话后退出码 0） | Windows 无法投递 SIGTERM，需要另设通道（见 §4.3） |
| 官方 `@deepseek-ai/*` 包与 dsh 同版本发布，其 `latest` 标签可能停留在很旧的版本 | 官方插件按当前 dsh 版本锁定安装 |
| 社区插件约定打 `dsh-plugin` 关键字（npm 上有约 5600 个） | 插件市场直接用 npm 搜索接口 |
| `desktop` 配置名保留给 DeepSeek 官方 Electron 应用 | 启动器隐藏该配置，不触碰 |

官方也有一个 Electron 桌面端，但其安装包尚未公开发布（GitHub Releases 无产物），且与 dsh 版本绑定发布。社区的 `anywhere-labs/dsh-desktop` 则内置固定版本的 dsh。**本启动器的定位不同：它不打包 dsh，而是管理官方 npm 发布的多个版本。**

## 2. 设计目标与非目标

目标：

1. **零前置依赖**：用户机器上没有 Node.js、pnpm 也能用。
2. **可控的版本**：随时在通道之间切换、安装任意历史版本、一键回滚。
3. **插件全流程**：搜索 → 查看 → 安装 → 启用/停用 → 更新 → 卸载，不必打开终端。
4. **国内可用**：镜像源、代理、下载进度与校验。
5. **不越权**：不修改用户的全局 npm/pnpm 配置，不接管 `$DSH_HOME` 中属于 dsh 的数据。

非目标（当前版本）：

- 不替代 dsh Web 界面本身的功能（模型设置、会话管理仍在 Web 界面里）。
- 不启动非 Web 形态的配置（`headless`/`sdk`/`acp` 需要 stdio 或一次性任务，不适合图形启动器）。
- 不实现启动器自身的自动更新（见 §8）。

## 3. 总体结构

```
src/
├── shared/          IPC 契约：类型 + 方法白名单（主进程与渲染进程共用）
├── main/
│   ├── core/        纯 Node 实现，不 import electron —— 可单测、可脱离 UI 跑 E2E
│   │   ├── http / mirrors / paths / proc / util      基础设施
│   │   ├── node-runtime / pnpm                      运行时下载与校验
│   │   ├── registry / dsh-versions                  npm 元数据与版本安装
│   │   ├── profiles / plugins                       配置、插件清单与插件操作
│   │   ├── supervisor                               dsh 进程生命周期
│   │   ├── tasks / settings                         任务队列与设置
│   │   └── launcher.ts                              LauncherService：编排以上所有能力
│   └── index.ts     Electron 外壳：窗口、托盘、IPC、代理、safeStorage、对话框
├── preload/         contextBridge 暴露 window.launcher（仅白名单方法）
└── renderer/        React 界面（启动 / 版本 / 插件 / 市场 / 设置）
```

**为什么把核心逻辑与 Electron 分离**：所有下载、安装、进程管理都能在 vitest 里用真实的 npm 与真实的 dsh 跑通（`test/e2e.test.ts`），不需要启动图形界面；Electron 只提供 `fetch`、代理、加密、对话框等平台能力，通过 `PlatformHooks` 注入。

## 4. 关键机制

### 4.1 数据布局

启动器自己的数据目录（Windows 为 `%LOCALAPPDATA%\dsh-launcher`，macOS 为 `~/Library/Application Support/dsh-launcher`，Linux 为 `~/.local/share/dsh-launcher`）：

```
<数据目录>/
├── settings.json          启动器设置（环境变量值经系统凭据加密）
├── node/v24.21.0/         托管的 Node.js 运行时
├── pnpm/                  托管的 pnpm 11
├── bin/                   pnpm shim + 关机桥接脚本
├── versions/0.1.5-rc.2/   每个 dsh 版本一个独立安装目录
└── logs/                  每次运行的 dsh 输出
```

选取顺序：环境变量 `DSH_LAUNCHER_DATA` → 免安装单文件所在目录下的 `dsh-launcher-data/`（portable 目标运行于临时解包目录，只有 `PORTABLE_EXECUTABLE_DIR` 知道真实位置）→ 解包目录中放有 `portable` 标记文件时用 `data/` → 上述按用户的默认位置。

`$DSH_HOME`（默认 `~/.dsh`）属于 dsh：会话、设置、凭据、配置与插件都在那里，启动器只读取和按 dsh 的规则修改，不迁移、不重写。

### 4.2 安装与更新流程

- **运行时**：从 `index.json` 选出满足 `engines` 的最新 LTS → 按 `SHASUMS256.txt` 校验下载 → 解压到暂存目录 → 重命名就位 → 运行 `node --version` 自检。
- **dsh 版本**：在暂存目录里 `npm install @deepseek-ai/dsh@<版本>` → 运行 `dsh --version` 自检 → 重命名为 `versions/<版本>`。失败或中断不会留下“看起来可用”的半成品。
- **更新**：按通道读取 dist-tag。可选“自动下载”，运行中则记为 `pendingVersion`，下次启动时切换；旧版本按“保留数量”清理，正在使用和正在运行的版本永不删除。

### 4.3 dsh 进程管理

启动命令（`--no-open` 由启动器自己决定何时开浏览器）：

```
<托管 node> --import <bin/dsh-launcher-bridge.mjs> <dsh bin> --profile <配置> --no-open --port <端口> [附加参数]
```

三个要点：

1. **就绪判定**：等 dsh 打印 `dsh web: http://127.0.0.1:<端口>/?token=…`。只探测端口是不够的——那时根路径仍返回 401，浏览器打开会看到“authentication required”。捕获到的带 token 地址用于“打开 Web 界面”，日志与日志文件里 token 一律显示为 `***`。
2. **优雅退出**：Windows 无法向子进程投递 SIGTERM。`--import` 预加载的桥接脚本在 Node IPC 通道上等待启动器的停止消息，收到后 `process.emit('SIGTERM')`，复用 dsh 自己的有界收尾逻辑（实测退出码 0）。超时未退出才 `taskkill /T /F` 结束进程树。启动器意外退出时 IPC 断开，桥接脚本同样触发收尾，不留孤儿进程。
3. **端口占用**：启动前探测端口，被占用时（默认）自动顺延；dsh 输出里出现 `EADDRINUSE` 也会被识别成可读的失败原因。

### 4.4 插件操作

所有增删改都走 `dsh plugin --profile <配置> <pnpm 参数>`，而不是自己调 pnpm——这样 bundle 的启用/停用由 dsh 按它自己的规则协调（`dsh.profile.bundles` 的重算、停用状态的保留）。启动器只在两处直接读写 profile 文件，且都持有 dsh 的 `package.json.lock`：

- 启用/停用组合包：增删 `dsh.profile.bundles`（依赖保留）。
- 允许构建脚本：把 `pnpm-workspace.yaml` 中待决的包置为 `true`（仅限确切包名，不接受通配符）。

同一配置下的安装会**合并成一次 pnpm 运行**：每次 `pnpm add` 都要完整解析依赖并做一次 pnpm 11 的供应链校验（实测一个 172 条依赖的配置要 31 秒），所以连点三个插件如果逐个跑就是三次全量开销。启动器在任务真正开始执行的那一刻才收集该配置累积的安装请求，排在前面的运行结束前点的插件会一起进入下一次运行，界面上显示为一个「安装 N 个插件」任务，各个调用方仍各自得到成功或失败。安装期间的 pnpm 输出会被解析成进度（校验供应链 / 解析依赖 / 变更包数），避免长时间看起来像卡住。

pnpm 11 在任何依赖的构建脚本悬而未决时，会让该配置下的**每一次安装都失败**。因此界面同时提供「允许构建」和「不运行」两个选择——写入 `allowBuilds` 的 `true` 或 `false` 都算已决定，都能解除阻塞，区别只在于脚本是否执行。只有本次运行的输出（`ERR_PNPM_IGNORED_BUILDS`）才会被判定为构建拦截；`pnpm-workspace.yaml` 里遗留的待决项不会再被误报成新失败的原因。

版本策略：官方 `@deepseek-ai/*` 包按当前 dsh 版本精确安装（`--save-exact`），社区插件用 `latest` 与 pnpm 默认的 caret。更新检查会读取**目标版本**声明的 peer 范围，若不包含当前 dsh 版本则标记“可能不兼容”；查询失败的插件会单独列出，而不是静默当作“已是最新”。

### 4.5 网络：镜像与代理

- 启动器自身的下载走 Electron `net.fetch`，跟随会话代理设置。
- 传给子进程的变量按工具区分：npm 认 `npm_config_*`，**pnpm 11 只认 `pnpm_config_*`**（实测 pnpm 11 完全忽略 `npm_config_registry` 与 `HTTP_PROXY`/`HTTPS_PROXY`），因此两套都设置，否则镜像与代理对插件安装不生效。
- 本机地址始终加入 `NO_PROXY`。
- 插件市场的关键字搜索固定走 npmjs.org（npmmirror 不提供搜索接口），包元数据与下载仍走用户选择的源。

### 4.6 插件市场：召回与排序

npm 的搜索接口只给一个不透明的 `searchScore`：实测它返回的 `quality`、`maintenance`、`popularity` 三项**全是 1.00**（已废弃字段），`dependents` 对几乎所有插件都是 0，中文查询也基本排不出东西。所以排序不能交给它。

启动器改为**自己建索引、自己排序**：

1. **索引**：分页抓取 `keywords:dsh-plugin` 的全部包（每页 250，约 24 次请求；npm 深翻页有重叠，去重后约 5.2k/5.9k），缓存在 `<数据目录>/cache/market-index.json`，有效期 6 小时。首次建立作为带进度的任务展示，过期后台刷新，用户可手动刷新。
2. **召回**：查询分词后与包名、关键字、描述逐项匹配，**每个词都必须命中**（"memory mcp" 不会返回所有记忆插件）。CJK 不按空格切分，直接作子串匹配，因此「记忆」「主题」这类中文查询能命中中文描述与关键字。
3. **粗排**（全量、只用便宜字段）：

   ```
   有查询：0.6 × 文本相关度 + 0.25 × 下载量(log10 归一) + 0.15 × 新鲜度(14 天内满分，其后指数衰减)
   无查询：0.55 × 下载量 + 0.45 × 新鲜度        ← 推荐位，并限制同一作者最多 2 个
   ```

   文本相关度按命中位置分层：包名完全相同 1.0 > 包名前缀 0.9 > 包名包含 0.78 > 关键字精确 0.7 > 关键字包含 0.55 > 描述包含 0.45。包名比较会忽略作者共用的 `dsh-` 前缀。
4. **精排**（只对候选窗口，约 80 个）：读取这些包的 manifest（缓存 24 小时），拿到只有 manifest 才有的三件事——是否声明 `dsh.bundle`、peer 范围是否兼容当前 dsh、是否已弃用——再调整分数：组合包 +0.1、非组合包 −0.3、不兼容 −0.25、已弃用 −0.45、官方 +0.06、关键字堆砌（>20 个）−0.04、无描述 −0.05。筛选「只看组合包 / 隐藏不兼容」也在这一步生效。
5. **精确包名**：有查询时并行做两件事——按关键字向 npm 查一次（把索引没覆盖到的包并进来），以及当查询本身像包名时直接查该包。实测 `dsh-better-sidebar` 这种**完全没有声明 keywords** 的热门插件，只有直查才找得到。完全同名 +0.5、去掉 scope 或 `dsh-` 前缀后同名 +0.2，因此用户输入的那个包排在同名 fork 之前。直查会先判断"是否像 dsh 插件"（有 `dsh` 字段、带 dsh 关键字或名字含 dsh），否则搜 "theme" 会把 2015 年一个叫 `theme` 的无关 npm 包拉进来。
6. **话题**：从索引的关键字统计出 MCP、模型接入、技能、主题美化、记忆等分类及其数量，作为空查询时的入口。

代价：首次进入市场需要建索引（约 30–50 秒，有进度）；之后搜索走本地，只有精排的 manifest 是网络请求且命中缓存后为零。

### 4.7 并发与任务

所有会写磁盘的操作（下载、安装、pnpm 运行、删除版本）经由一个串行任务队列，带进度、日志、取消；界面右下角的任务面板展示它们。读操作（列插件、查更新、搜索）不排队。

## 5. 界面

五个页面，均为中文：

- **启动**：状态卡（未安装/已停止/启动中/运行中/失败）、一键安装、启动/停止/重启/打开 Web 界面、配置与端口与工作区、运行日志控制台。
- **版本**：通道切换、更新提示、已安装版本（切换/删除/更新日志）、可安装版本列表、自动检查与保留策略。
- **插件**：按配置查看；安装（npm 包名 / `github:用户/仓库` / 本地目录 / `.tgz`）、检查更新、批量更新、启用停用、卸载；构建脚本批准；dsh 自带组合包（核心只读、可选项可切换）。
- **插件市场**：npm 上 `dsh-plugin` 关键字的搜索结果与官方可选插件；安装前展示“是否组合包 / 兼容性 / 是否含安装脚本 / 是否已弃用 / 权限提醒”。
- **设置**：下载源、代理、启动选项、环境变量（加密保存）、路径、关于。

界面通过 `window.launcher` 单一桥接对象与主进程通信；浏览器里直接打开时会自动换成 `src/renderer/src/mock.ts` 的模拟后端，用于纯前端开发与走查（`npm run dev:web`）。

## 6. 安全考虑

- **渲染进程**：`contextIsolation` + `sandbox`，无 Node 集成；页面带 CSP；IPC 只接受方法白名单，并校验调用来源页面；外部链接只允许 http(s)，一律交给系统浏览器。
- **令牌**：dsh 的一次性登录 token 只保留在内存中用于打开浏览器，界面与日志文件里都替换为 `***`。
- **密钥**：设置里的环境变量值用 Electron `safeStorage`（Windows 上即 DPAPI）加密后写入 `settings.json`；解不开时留空而不是报废整份设置。界面也提示模型密钥更适合在 dsh Web 界面里配置。
- **插件风险**：插件代码以用户权限运行在 dsh 进程内，不受 agent 沙箱限制；安装前的确认框与市场详情都明确写出这一点。pnpm 拦截的构建脚本必须由用户逐次批准，启动器不代为放行，也不接受通配符批准。
- **不代管凭据**：启动器不读写 `$DSH_HOME/.credentials.yaml`，不碰用户的 npm/pnpm 全局配置。

## 7. 验证方式

- `npm test`：57 个单元测试，覆盖版本选择与剪枝、通道比较、兼容性判定、spec 分类、配置锁（含抢占死锁）、pnpm 构建批准的 YAML 读写、任务队列、shim 生成、ANSI 与日志切分、进程监督（用一个模拟 dsh 的脚本验证就绪、token 掩码、优雅退出与崩溃归因）。
- `npm run test:e2e`：对真实世界的端到端测试，使用独立的 `DSH_HOME`，不触碰用户的 `~/.dsh`。实测结果：
  - 下载 Node.js 24 LTS + pnpm 11 + dsh（npmmirror 下约 30 秒）；
  - 从内置 web 模板创建自定义配置；
  - 安装官方插件（自动锁定为当前 dsh 版本）、停用、启用、查更新、卸载；
  - 启动 `dsh web`，用它打印的 token 地址换取 `dsh-auth` cookie 并取回 200 的界面 HTML，再优雅停止（退出码 0）；
  - 插件市场：建立索引、中文查询、按包名精确查找、排序与筛选。
- 打包产物已实测：`npm run dist` 生成的安装包可静默安装、运行、静默卸载且无残留（安装目录、桌面与开始菜单快捷方式都被清理）；免安装单文件双击可运行，并把数据写在 exe 旁边的 `dsh-launcher-data/`。

## 8. 已知限制与后续

- **启动器自更新未实现**。计划用 electron-updater + GitHub Releases；在此之前需要手动下载新版本安装包。
- **macOS / Linux 未实测**：代码路径已按平台区分（tar 解压、`bin/node` 布局、进程组 kill），但只在 Windows 11 上实跑过。
- **只启动 Web 形态的配置**：`headless`/`sdk`/`acp` 需要 stdio 交互，不在图形启动器的范围内。
- **插件市场不做审核**：结果直接来自 npm 关键字搜索，排序为 npm 的相关度；是否可信由用户判断。
- **dsh 处于开发者预览期**，官方明确会有破坏性变更。启动器依赖的三处外部约定——`dsh plugin` 的 pnpm 转发、profile 清单结构、`dsh web` 的就绪输出——如果变动，E2E 测试会第一时间失败。
