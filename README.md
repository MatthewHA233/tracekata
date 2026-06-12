# TraceKata

AI 练习项目生成器 + VSCode 练习现场编排器。

面向已经会氛围编程、但想补回手写代码能力的人。它不是独立 IDE，不是课程平台，也不是新的 AI 聊天。

## 项目结构

```
tracekata/
├── src/                # 桌面端前端（React + Vite）
├── src-tauri/          # 桌面端后端（Tauri / Rust）
└── vscode-extension/   # VSCode 插件（附属，负责编辑器内的分栏编排）
```

## 桌面端

左列表右详情布局：

- 左侧：当前轨道的练习列表（✓ 已练过、● 选中）
- 右侧：选中练习的详情、文件、操作和运行结果
- 左下角：新建轨道、锚点记录、AI 能做什么

启动开发环境：

```bash
npm run tauri dev
```

检查前端：

```bash
npm run build
```

检查后端：

```bash
cd src-tauri
cargo test --lib
```

## VSCode 插件

桌面端管选题和运行，插件管编辑器内的现场布置（左栏手敲文件，右栏题目索引、基底、示范文件）。

只有 6 个命令：

- `TraceKata: 布置练习现场`
- `TraceKata: 运行练习`
- `TraceKata: 打开题目索引`
- `TraceKata: 收成锚点 Memo`
- `TraceKata: 打开 Memo 时间流`
- `TraceKata: 刷新`

构建与安装：

```bash
cd vscode-extension
npm run test:smoke
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension tracekata-*.vsix
```

## 配置

两端共用上层目录的 `tracekata.config.json`（轨道、练习、文件、运行命令），向上搜索定位。
