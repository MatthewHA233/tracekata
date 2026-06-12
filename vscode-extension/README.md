# TraceKata VSCode 插件

TraceKata 桌面项目的附属插件。它不重造编辑器，只做编辑器内的练习现场编排。

## 命令

- `TraceKata: 布置练习现场` — 左栏打开手敲文件，右栏打开题目索引、基底复习、示范文件。练习文件不存在时会用基底内容自动创建，已存在的文件永不覆盖。
- `TraceKata: 运行练习` — 在 VSCode 终端里运行选中练习。
- `TraceKata: 打开题目索引` — 打开题目索引.md。
- `TraceKata: 收成锚点 Memo` — 从选中文本或剪贴板收一条 memo 到 `.tracekata/memos.md`。
- `TraceKata: 打开 Memo 时间流` — 打开 memo 文件。
- `TraceKata: 刷新` — 刷新侧边栏。

## 侧边栏

- 轨道练习：当前轨道的练习节点，点击即布置现场
- 锚点 Memo：最近的 memo 标题

## 配置

从工作区向上搜索 `tracekata.config.json`，与桌面端共用同一份配置。

## 开发

```bash
npm run compile      # 编译
npm run test:smoke   # 编译 + 冒烟测试
```

打包安装：

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension tracekata-*.vsix
```
