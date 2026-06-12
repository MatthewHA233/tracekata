import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracekata-smoke-"));
const stubDir = path.join(root, "stub");

fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(
  path.join(stubDir, "vscode.js"),
  `
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label
    this.collapsibleState = collapsibleState
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id
  }
}

class EventEmitter {
  constructor() {
    this.event = () => undefined
  }
  fire() {}
  dispose() {}
}

module.exports = {
  TreeItem,
  ThemeIcon,
  EventEmitter,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { One: 1, Two: 2 },
  window: {},
  workspace: {},
  commands: {},
  env: { clipboard: { readText: async () => '', writeText: async () => undefined } },
}
`,
  "utf8",
);

process.env.NODE_PATH = stubDir;
require("node:module").Module._initPaths();

const extension = require("../dist/extension.js");
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

// 真实项目配置：typescript-practice/tracekata.json
const projectConfigPath = path.resolve("../../typescript-practice/tracekata.json");
const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, "utf8"));

const keptCommands = [
  "tracekata.setupExerciseScene",
  "tracekata.captureMemo",
  "tracekata.openMemoTimeline",
  "tracekata.refreshViews",
  "tracekata.runExercise",
  "tracekata.openIndex",
];

for (const command of keptCommands) {
  if (!packageJson.contributes.commands.some((item) => item.command === command)) {
    throw new Error(`Missing contributed command: ${command}`);
  }
}

if (packageJson.contributes.commands.length !== keptCommands.length) {
  throw new Error("package.json contributes extra commands beyond the kept set.");
}

if (!projectConfig.tracks?.[0] || projectConfig.tracks[0].baseOffset !== 5) {
  throw new Error("Progressive track baseOffset should be configured as 5.");
}

const normalized = extension.__test.normalizeConfig({});
if (normalized.indexFile !== "题目索引.md" || normalized.memosFile !== ".tracekata/memos.md") {
  throw new Error("normalizeConfig defaults are wrong.");
}

if (extension.__test.normalizeTags("函数 参数") !== "#函数 #参数") {
  throw new Error("normalizeTags should prefix tags with #.");
}

if (extension.__test.firstMeaningfulLine("\n\n  你好  \n第二行") !== "你好") {
  throw new Error("firstMeaningfulLine should skip empty lines and trim.");
}

console.log("TraceKata smoke test ok: per-project config, commands, memo helpers");
