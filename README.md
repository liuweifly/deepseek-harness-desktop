# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)(`dsh web`)包装成原生 macOS 桌面 App——打开即用,不用再手动开终端、记端口。

> ⚠️ 非官方项目。DeepSeek 相关名称与鲸鱼标识归 DeepSeek 所有;本仓库图标为原创绘制(灵感来自鲸鱼形象),与本项目代码同以 MIT 协议开源。

## 特性

- **一键启动**:打开 App 自动在后台拉起 `dsh web`(默认 `127.0.0.1:3080`),服务就绪后打开原生窗口
- **智能复用**:若 3080 已有 Harness 实例(比如你正开着网页版),直接复用,不重复启动;退出时也只停掉自己拉起的服务,**不会误杀共享实例**
- **与网页版数据完全一致**:共享 `~/.dsh` 状态,会话、技能、子任务、历史记录互通
- **干净的进程管理**:`dsh` 会 fork 子进程承载实际服务,退出时按进程组整体清理,不留孤儿进程
- **原生体验**:单实例锁、系统浏览器打开外部链接、完整菜单(Cmd+Q / Cmd+R / DevTools / 缩放 / 全屏)
- **开箱即用**:无 API Key 要求(走 Harness 自身配置),无需安装 Node/Homebrew

## 安装

### 方式一:直接下载

从 [Releases](../../releases) 下载 `DeepSeek.app`(或 dmg),拖入「应用程序」即可。

> 本地构建的 App 使用 ad-hoc 签名;若 macOS 提示无法打开,执行:
> `xattr -cr /Applications/DeepSeek.app`

### 方式二:自行打包

需要 Node.js ≥ 18 与 macOS(Apple Silicon / Intel 均可)。

```bash
git clone https://github.com/liuweifly/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm install
npm run pack        # 产出 dist/mac-arm64/DeepSeek.app
cp -R dist/mac-arm64/DeepSeek.app /Applications/
codesign --force --deep --sign - /Applications/DeepSeek.app
```

## 使用

| 场景 | 行为 |
|---|---|
| 网页版未运行 | App 自动启动 Harness 服务,窗口打开即用 |
| 网页版已运行 | 复用现有服务,不重复启动 |
| 关闭窗口 / Cmd+Q | 只停止自己拉起的服务;共享服务不受影响 |

**自定义端口**:启动前设置环境变量 `DSH_DESKTOP_PORT`(默认 `3080`)。

**服务日志**:`~/Library/Application Support/DeepSeek/server.log`

## 工作原理

```
┌─────────────────────────────┐
│  DeepSeek.app (Electron)    │
│  ┌───────────────────────┐  │
│  │  Harness Web UI       │  │
│  └───────────────────────┘  │
└──────────────┬──────────────┘
               │ localhost
┌──────────────┴──────────────┐
│  dsh web (本机 Node 进程)   │
│  会话 / 技能 / 子任务 / 工具 │
└─────────────────────────────┘
```

App 启动时探测端口:可用则 `spawn` Harness(通过 `ELECTRON_RUN_AS_NODE` 复用 Electron 自带 Node,保证原生模块 ABI 一致);被占用则直接连入。

## 项目结构

```
main.js                 Electron 主进程(服务生命周期 + 窗口 + 菜单)
preload.js             渲染进程桥(极简)
scripts/postpack.js    打包后补全生产依赖树(electron-builder 在 dsh 深层依赖上会漏包)
build/icon.svg         图标源文件(可自行替换后重新打包)
```

## 开发

```bash
npm install
npm start               # 开发模式直接运行
npm run pack            # 打包 .app
```

## 已知限制

- 目前仅支持 macOS(arm64 已验证;x64 理论上可用)
- 图标为原创绘制,与官方鲸鱼标识不完全一致

## License

[MIT](LICENSE) © liuweifly

Built on [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness).
