import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

// 每个练习项目目录下有一份 tracekata.json，插件扫描工作区发现项目，
// 选中状态只活在每次命令里，不写盘。

type Exercise = {
  id: string;
  title: string;
  baseFrom?: string;
  practiceFiles: string[];
  demoFiles: string[];
  run: {
    file: string;
    args: string[];
  };
};

type ProgressiveTrack = {
  id: string;
  title: string;
  baseOffset: number;
  exerciseIds: string[];
  createdAt?: string;
};

type ProjectConfig = {
  name?: string;
  indexFile: string;
  memosFile: string;
  pinned: boolean;
  archived: boolean;
  tracks: ProgressiveTrack[];
  exercises: Exercise[];
};

type Project = {
  id: string;
  dir: string;
  config: ProjectConfig;
};

function normalizeConfig(raw: Partial<ProjectConfig>): ProjectConfig {
  return {
    name: raw.name,
    indexFile: raw.indexFile?.trim() || "题目索引.md",
    memosFile: raw.memosFile?.trim() || ".tracekata/memos.md",
    pinned: raw.pinned ?? false,
    archived: raw.archived ?? false,
    tracks: raw.tracks ?? [],
    exercises: raw.exercises ?? [],
  };
}

function loadProjectAt(dir: string): Project | undefined {
  const configPath = path.join(dir, "tracekata.json");
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<ProjectConfig>;
    return {
      id: path.basename(dir),
      dir,
      config: normalizeConfig(raw),
    };
  } catch {
    return undefined;
  }
}

function discoverProjects(): Project[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const projects: Project[] = [];

  for (const folder of folders) {
    const root = folder.uri.fsPath;

    const own = loadProjectAt(root);
    if (own) {
      projects.push(own);
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") {
        continue;
      }

      const project = loadProjectAt(path.join(root, entry.name));
      if (project) {
        projects.push(project);
      }
    }
  }

  projects.sort((a, b) => {
    if (a.config.pinned !== b.config.pinned) {
      return a.config.pinned ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });

  return projects;
}

function requireProjects(): Project[] {
  const projects = discoverProjects();
  if (projects.length === 0) {
    throw new Error("工作区里没有练习项目（含 tracekata.json 的目录）。");
  }
  return projects;
}

function projectLabel(project: Project) {
  return project.config.name?.trim() || project.id;
}

async function pickProject(projects: Project[]) {
  if (projects.length === 1) {
    return projects[0];
  }

  const item = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: projectLabel(project),
      description: project.id,
      project,
    })),
    {
      placeHolder: "选择一个练习项目",
    },
  );

  return item?.project;
}

async function pickExercise(project: Project) {
  const item = await vscode.window.showQuickPick(
    project.config.exercises.map((exercise) => ({
      label: `${exercise.id} ${exercise.title}`,
      description: exercise.baseFrom ? `基底：${exercise.baseFrom}` : undefined,
      exercise,
    })),
    {
      placeHolder: `选择 ${projectLabel(project)} 里的练习`,
    },
  );

  return item?.exercise;
}

async function openFileInColumn(filePath: string, viewColumn: vscode.ViewColumn) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, {
    viewColumn,
    preview: false,
    preserveFocus: false,
  });
}

function uniq(values: string[]) {
  return [...new Set(values)];
}

function getExercise(project: Project, exerciseId: string) {
  return project.config.exercises.find((exercise) => exercise.id === exerciseId);
}

function newestTrack(project: Project) {
  const tracks = [...project.config.tracks];
  tracks.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return tracks[0];
}

function getDefaultExercise(project: Project) {
  const track = newestTrack(project);
  const lastId = track?.exerciseIds.at(-1);
  return (lastId ? getExercise(project, lastId) : undefined) ?? project.config.exercises.at(-1);
}

function getBaseExercise(project: Project, exercise: Exercise) {
  const track = project.config.tracks.find((item) => item.exerciseIds.includes(exercise.id));
  if (track) {
    const index = track.exerciseIds.indexOf(exercise.id);
    const baseId = track.exerciseIds[index - track.baseOffset];
    if (baseId) {
      return getExercise(project, baseId);
    }
  }

  return exercise.baseFrom ? getExercise(project, exercise.baseFrom) : undefined;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensurePracticeFilesFromBase(project: Project, exercise: Exercise) {
  const baseExercise = getBaseExercise(project, exercise);

  for (const [index, file] of exercise.practiceFiles.entries()) {
    const targetPath = path.join(project.dir, file);
    if (fs.existsSync(targetPath)) {
      continue;
    }

    ensureDir(path.dirname(targetPath));
    const baseFile = baseExercise?.practiceFiles[index] ?? baseExercise?.practiceFiles[0];
    const basePath = baseFile ? path.join(project.dir, baseFile) : undefined;
    const baseContent = basePath && fs.existsSync(basePath) ? fs.readFileSync(basePath, "utf8") : "";
    const header = [
      `// TraceKata ${exercise.id}: ${exercise.title}`,
      baseExercise ? `// Base from ${baseExercise.id}: ${baseExercise.title}` : "// Base: empty start",
      "// Existing files are never overwritten.",
      "",
    ].join("\n");

    fs.writeFileSync(targetPath, `${header}${baseContent}`, "utf8");
  }
}

async function setupExerciseScene(projectId?: string, exerciseId?: string) {
  try {
    const projects = requireProjects();
    const project = projectId
      ? projects.find((item) => item.id === projectId)
      : await pickProject(projects);
    if (!project) {
      return;
    }

    const exercise = exerciseId
      ? getExercise(project, exerciseId)
      : getDefaultExercise(project);
    if (!exercise) {
      vscode.window.showInformationMessage("这个项目还没有可布置的练习。");
      return;
    }

    ensurePracticeFilesFromBase(project, exercise);

    for (const file of exercise.practiceFiles) {
      await openFileInColumn(path.join(project.dir, file), vscode.ViewColumn.One);
    }

    const baseExercise = getBaseExercise(project, exercise);
    const referenceFiles = uniq([
      project.config.indexFile,
      ...(baseExercise?.practiceFiles ?? []),
      ...exercise.demoFiles,
    ]);

    for (const file of referenceFiles) {
      await openFileInColumn(path.join(project.dir, file), vscode.ViewColumn.Two);
    }

    vscode.window.showInformationMessage(`已布置 ${exercise.id} ${exercise.title}`);
  } catch (error) {
    showError(error);
  }
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(message);
}

function quoteShellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function memoFilePath(project: Project) {
  return path.join(project.dir, project.config.memosFile);
}

function localDateTime(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function getSelectedEditorText() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return "";
  }

  return editor.document.getText(editor.selection).trim();
}

function firstMeaningfulLine(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function normalizeTags(input: string | undefined) {
  if (!input) {
    return "";
  }

  return input
    .split(/[\s,，]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .join(" ");
}

function appendMemo(project: Project, title: string, content: string, tags: string) {
  const filePath = memoFilePath(project);
  ensureDir(path.dirname(filePath));

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "# TraceKata 锚点 Memo\n\n", "utf8");
  }

  const memo = [
    `## ${title}`,
    "",
    localDateTime(new Date()),
    "",
    content.trim(),
    "",
    tags,
    "",
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");

  fs.appendFileSync(filePath, `${memo}\n`, "utf8");
}

async function captureMemo() {
  try {
    const projects = requireProjects();
    const project = await pickProject(projects);
    if (!project) {
      return;
    }

    const selectedText = getSelectedEditorText();
    const clipboardText = (await vscode.env.clipboard.readText()).trim();
    const seed = selectedText || clipboardText;
    const content =
      seed ||
      (await vscode.window.showInputBox({
        prompt: "粘贴这次对话里要收成 Memo 的内容",
      }))?.trim();

    if (!content) {
      return;
    }

    const defaultTitle = firstMeaningfulLine(content)?.slice(0, 36) ?? "未命名 Memo";
    const title =
      (await vscode.window.showInputBox({
        prompt: "一句话标题",
        value: defaultTitle,
      }))?.trim() || defaultTitle;

    const tags = normalizeTags(
      await vscode.window.showInputBox({
        prompt: "标签，可选，例如 JavaScript 函数 对象",
      }),
    );

    appendMemo(project, title, content, tags);
    await openMemoTimeline(project.id);
    memoProvider?.refresh();
  } catch (error) {
    showError(error);
  }
}

async function openMemoTimeline(projectId?: string) {
  try {
    const projects = requireProjects();
    const project = projectId
      ? projects.find((item) => item.id === projectId)
      : await pickProject(projects);
    if (!project) {
      return;
    }

    const filePath = memoFilePath(project);
    ensureDir(path.dirname(filePath));

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "# TraceKata 锚点 Memo\n\n", "utf8");
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
    });
  } catch (error) {
    showError(error);
  }
}

type TreeEntry =
  | { kind: "action"; label: string; description?: string; command: string; args?: unknown[] }
  | { kind: "project"; label: string; project: Project }
  | { kind: "track"; label: string; project: Project; track: ProgressiveTrack }
  | { kind: "exercise"; label: string; project: Project; exercise: Exercise; base?: Exercise }
  | { kind: "memo"; label: string; projectId: string };

class TraceKataTreeItem extends vscode.TreeItem {
  constructor(entry: TreeEntry, collapsibleState = vscode.TreeItemCollapsibleState.None) {
    super(entry.label, collapsibleState);

    if (entry.kind === "action") {
      this.description = entry.description;
      this.command = {
        title: entry.label,
        command: entry.command,
        arguments: entry.args,
      };
      this.iconPath = new vscode.ThemeIcon("play");
    }

    if (entry.kind === "project") {
      this.description = entry.project.config.archived ? "已归档" : undefined;
      this.iconPath = new vscode.ThemeIcon("folder");
    }

    if (entry.kind === "track") {
      this.description = `${entry.track.exerciseIds.length} 题`;
      this.iconPath = new vscode.ThemeIcon("layers");
    }

    if (entry.kind === "exercise") {
      this.description = entry.base ? `基底 ${entry.base.id}` : "起点";
      this.tooltip = `${entry.exercise.id} ${entry.exercise.title}`;
      this.command = {
        title: "布置练习现场",
        command: "tracekata.setupExerciseScene",
        arguments: [entry.project.id, entry.exercise.id],
      };
      this.iconPath = new vscode.ThemeIcon("edit");
    }

    if (entry.kind === "memo") {
      this.iconPath = new vscode.ThemeIcon("note");
      this.command = {
        title: "打开 Memo 时间流",
        command: "tracekata.openMemoTimeline",
        arguments: [entry.projectId],
      };
    }
  }
}

class TrackTreeProvider implements vscode.TreeDataProvider<TreeEntry> {
  private readonly emitter = new vscode.EventEmitter<TreeEntry | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh() {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TreeEntry) {
    if (element.kind === "project") {
      return new TraceKataTreeItem(element, vscode.TreeItemCollapsibleState.Expanded);
    }

    if (element.kind === "track") {
      return new TraceKataTreeItem(element, vscode.TreeItemCollapsibleState.Collapsed);
    }

    return new TraceKataTreeItem(element);
  }

  getChildren(element?: TreeEntry) {
    const projects = discoverProjects();

    if (projects.length === 0) {
      return Promise.resolve<TreeEntry[]>([
        {
          kind: "action",
          label: "打开包含练习项目的工作区",
          description: "需要 tracekata.json",
          command: "workbench.action.files.openFolder",
        },
      ]);
    }

    if (element?.kind === "project") {
      const tracks = [...element.project.config.tracks];
      tracks.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      return Promise.resolve(
        tracks.map((track) => ({
          kind: "track" as const,
          label: track.title,
          project: element.project,
          track,
        })),
      );
    }

    if (element?.kind === "track") {
      return Promise.resolve(
        element.track.exerciseIds
          .map((id) => getExercise(element.project, id))
          .filter((exercise): exercise is Exercise => Boolean(exercise))
          .map((exercise) => ({
            kind: "exercise" as const,
            label: `${exercise.id} ${exercise.title}`,
            project: element.project,
            exercise,
            base: getBaseExercise(element.project, exercise),
          })),
      );
    }

    const items: TreeEntry[] = [];
    const first = projects.find((project) => !project.config.archived) ?? projects[0];
    const current = getDefaultExercise(first);

    if (current) {
      items.push({
        kind: "action",
        label: `布置当前练习 ${current.id}`,
        description: current.title,
        command: "tracekata.setupExerciseScene",
        args: [first.id, current.id],
      });
    }

    items.push({
      kind: "action",
      label: "收成 Memo",
      description: "从对话/剪贴板生成",
      command: "tracekata.captureMemo",
    });

    items.push({
      kind: "action",
      label: "运行练习",
      command: "tracekata.runExercise",
    });

    for (const project of projects) {
      items.push({
        kind: "project",
        label: projectLabel(project),
        project,
      });
    }

    return Promise.resolve(items);
  }
}

class MemoTreeProvider implements vscode.TreeDataProvider<TreeEntry> {
  private readonly emitter = new vscode.EventEmitter<TreeEntry | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh() {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TreeEntry) {
    return new TraceKataTreeItem(element);
  }

  getChildren() {
    const projects = discoverProjects();
    const items: TreeEntry[] = [
      {
        kind: "action",
        label: "收成 Memo",
        description: "从对话/剪贴板",
        command: "tracekata.captureMemo",
      },
      {
        kind: "action",
        label: "打开时间流",
        command: "tracekata.openMemoTimeline",
      },
    ];

    for (const project of projects) {
      const filePath = memoFilePath(project);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const headings = fs
        .readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("## "))
        .slice(-8)
        .reverse()
        .map((line) => line.replace(/^##\s+/, ""));

      for (const heading of headings) {
        items.push({
          kind: "memo",
          label: projects.length > 1 ? `${projectLabel(project)} · ${heading}` : heading,
          projectId: project.id,
        });
      }
    }

    return Promise.resolve(items);
  }
}

let trackProvider: TrackTreeProvider | undefined;
let memoProvider: MemoTreeProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  trackProvider = new TrackTreeProvider();
  memoProvider = new MemoTreeProvider();

  context.subscriptions.push(vscode.window.registerTreeDataProvider("tracekata.control", trackProvider));
  context.subscriptions.push(vscode.window.registerTreeDataProvider("tracekata.memos", memoProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tracekata.setupExerciseScene",
      async (projectId?: string, exerciseId?: string) => {
        await setupExerciseScene(projectId, exerciseId);
      },
    ),
  );

  context.subscriptions.push(vscode.commands.registerCommand("tracekata.captureMemo", captureMemo));
  context.subscriptions.push(
    vscode.commands.registerCommand("tracekata.openMemoTimeline", async (projectId?: string) => {
      await openMemoTimeline(projectId);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("tracekata.refreshViews", () => {
      trackProvider?.refresh();
      memoProvider?.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tracekata.runExercise", async () => {
      try {
        const projects = requireProjects();
        const project = await pickProject(projects);
        if (!project) {
          return;
        }

        const exercise = await pickExercise(project);
        if (!exercise) {
          return;
        }

        const terminal = vscode.window.createTerminal({
          name: `TraceKata ${exercise.id}`,
          cwd: project.dir,
        });

        const command = ["node", quoteShellArg(exercise.run.file), ...exercise.run.args.map(quoteShellArg)].join(" ");
        terminal.show();
        terminal.sendText(command);
      } catch (error) {
        showError(error);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tracekata.openIndex", async () => {
      try {
        const projects = requireProjects();
        const project = await pickProject(projects);
        if (!project) {
          return;
        }

        const uri = vscode.Uri.file(path.join(project.dir, project.config.indexFile));
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        showError(error);
      }
    }),
  );
}

export function deactivate() {}

export const __test = {
  normalizeConfig,
  normalizeTags,
  firstMeaningfulLine,
};
