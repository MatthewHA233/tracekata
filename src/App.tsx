import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type TrackListItem = {
  id: string;
  title: string;
  createdAt?: string;
  exerciseCount: number;
};

type ProjectListItem = {
  id: string;
  displayName: string;
  pinned: boolean;
  archived: boolean;
  tracks: TrackListItem[];
};

type TrackSummary = {
  id: string;
  title: string;
  baseOffset: number;
  exerciseIds: string[];
};

type ExerciseListItem = {
  id: string;
  title: string;
  finished: boolean;
};

type ExerciseSummary = {
  id: string;
  title: string;
  runFile: string;
  runArgs: string[];
};

type FileItem = {
  name: string;
  relativePath: string;
  kind: string;
  exists: boolean;
  isEmpty: boolean;
  lineCount: number;
};

type FileGroup = {
  kind: string;
  files: FileItem[];
};

type MemoEntry = {
  title: string;
  body: string;
  time: string;
  tags: string[];
};

type AiSkill = {
  name: string;
  description: string;
  source: string;
  path: string;
};

type DashboardState = {
  workspaceRoot: string;
  projects: ProjectListItem[];
  currentProjectId?: string;
  currentTrack?: TrackSummary;
  trackExercises: ExerciseListItem[];
  currentExercise?: ExerciseSummary;
  baseHint: string;
  fileGroups: FileGroup[];
  memos: MemoEntry[];
  aiSkills: AiSkill[];
};

type CommandResult = {
  message: string;
  changedFiles: string[];
};

type RunResult = {
  command: string;
  status?: number;
  stdout: string;
  stderr: string;
};

type MainView = "exercise" | "memo" | "skills";

type SelectionArgs = {
  projectId: string | null;
  trackId: string | null;
  exerciseId: string | null;
};

const groupNames: Record<string, string> = {
  practice: "手敲文件",
  reference: "题目提示",
  base: "基底复习",
  demo: "示范文件",
};

const TRACKS_SHOWN = 5;

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const icon24Props = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function IconMemo() {
  return (
    <svg {...iconProps}>
      <path d="M13.5 8.5v4a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 12.5V4.5A1.5 1.5 0 0 1 3.5 3h4" />
      <path d="M12.4 1.9a1.3 1.3 0 0 1 1.8 1.8L8.6 9.3 6 9.9l.6-2.6 5.8-5.4z" />
    </svg>
  );
}

function IconSparkle() {
  return (
    <svg {...iconProps}>
      <path d="M7 2.5l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1 1-2.9z" />
      <path d="M12.2 9.8l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg {...iconProps}>
      <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h2.6l1.5 1.8H13a1.5 1.5 0 0 1 1.5 1.5v5.2A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7z" />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      {...iconProps}
      style={{
        transform: open ? "none" : "rotate(-90deg)",
        transition: "transform 0.2s ease",
      }}
    >
      <polyline points="4,6 8,10 12,6" />
    </svg>
  );
}

function IconDots() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3.2" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.8" cy="8" r="1.2" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg {...icon24Props}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2h1z" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg {...icon24Props}>
      <path d="M21.17 6.81a2.82 2.82 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63l4.36-1.32a2 2 0 0 0 .83-.5z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function IconCode() {
  return (
    <svg {...icon24Props}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function IconArchive() {
  return (
    <svg {...icon24Props}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [exerciseId, setExerciseId] = useState<string | null>(null);
  const [view, setView] = useState<MainView>("exercise");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [tracksShownAll, setTracksShownAll] = useState<Record<string, boolean>>({});
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [memoTitle, setMemoTitle] = useState("");
  const [memoBody, setMemoBody] = useState("");
  const [memoTags, setMemoTags] = useState("");

  function currentArgs(overrides?: Partial<SelectionArgs>): SelectionArgs {
    return {
      projectId,
      trackId,
      exerciseId,
      ...overrides,
    };
  }

  async function loadState(args?: Partial<SelectionArgs>) {
    setError("");
    try {
      const merged = currentArgs(args);
      const nextState = await invoke<DashboardState>("load_dashboard_state", merged);
      setState(nextState);
      // 把后端解析后的选中状态同步回来，保持一致
      setProjectId(nextState.currentProjectId ?? null);
      setTrackId(nextState.currentTrack?.id ?? null);
      setExerciseId(nextState.currentExercise?.id ?? null);
    } catch (caught) {
      setError(String(caught));
    }
  }

  useEffect(() => {
    loadState({ projectId: null, trackId: null, exerciseId: null });
  }, []);

  useEffect(() => {
    if (!menuProjectId) return;
    const close = () => setMenuProjectId(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuProjectId]);

  function selectTrack(nextProjectId: string, nextTrackId: string) {
    setView("exercise");
    setRunResult(null);
    loadState({ projectId: nextProjectId, trackId: nextTrackId, exerciseId: null });
  }

  function selectExercise(id: string) {
    setView("exercise");
    setRunResult(null);
    loadState({ exerciseId: id });
  }

  async function call<T>(command: string, after?: (result: T) => void) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await invoke<T>(command, currentArgs());
      after?.(result);
      await loadState();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  }

  // 打开练习现场 = 先补齐练习文件，再让 VSCode 打开全部相关文件
  async function openScene() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await invoke<CommandResult>("prepare_exercise", currentArgs());
      const result = await invoke<CommandResult>("open_exercise_scene", currentArgs());
      setMessage(result.message);
      await loadState();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function openFile(relativePath: string) {
    setError("");
    setMessage("");
    try {
      const result = await invoke<CommandResult>("open_workspace_file", {
        relativePath,
      });
      setMessage(result.message);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function setProjectMeta(
    targetProjectId: string,
    payload: { displayName?: string; pinned?: boolean; archived?: boolean },
  ) {
    setError("");
    setMessage("");
    try {
      const result = await invoke<CommandResult>("set_project_meta", {
        projectId: targetProjectId,
        ...payload,
      });
      setMessage(result.message);
      await loadState();
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function revealInFinder(targetProjectId: string) {
    setError("");
    setMessage("");
    try {
      const result = await invoke<CommandResult>("reveal_project", {
        projectId: targetProjectId,
      });
      setMessage(result.message);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function saveMemo() {
    const tags = memoTags
      .split(/[,\s，、]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const time = new Date().toLocaleString("zh-CN", { hour12: false });

    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await invoke<CommandResult>("save_memo", {
        projectId,
        title: memoTitle,
        body: memoBody,
        tags,
        time,
      });
      setMessage(result.message);
      setMemoTitle("");
      setMemoBody("");
      setMemoTags("");
      await loadState();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!state && !error) {
    return (
      <main className="loading-screen">
        <p>正在读取练习项目...</p>
      </main>
    );
  }

  const current = state?.currentExercise;
  const runText = current
    ? ["node", current.runFile, ...current.runArgs].join(" ")
    : "";
  const currentProject = state?.projects.find(
    (project) => project.id === state.currentProjectId,
  );

  return (
    <main className="layout">
      <aside className={`sidebar${sidebarOpen ? "" : " collapsed"}`}>
        <div className="sidebar-inner">
          <div className="sidebar-top">
            <button
              type="button"
              className="icon-button"
              title={sidebarOpen ? "收起侧栏" : "展开侧栏"}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              >
                <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" />
                <line x1="6" y1="2.5" x2="6" y2="13.5" />
              </svg>
            </button>
          </div>

          <div className="sidebar-content">
            <nav className="side-nav">
              <button
                type="button"
                className={`nav-row${view === "memo" ? " active" : ""}`}
                onClick={() => setView(view === "memo" ? "exercise" : "memo")}
              >
                <span className="row-icon">
                  <IconMemo />
                </span>
                锚点记录
              </button>
              <button
                type="button"
                className={`nav-row${view === "skills" ? " active" : ""}`}
                onClick={() => setView(view === "skills" ? "exercise" : "skills")}
              >
                <span className="row-icon">
                  <IconSparkle />
                </span>
                AI 能做什么
              </button>
            </nav>

            <div className="project-section">
              <p className="section-label">项目</p>

              {state?.projects.map((project) => {
                const collapsed = expandedProjects[project.id] === false || project.archived;
                const showAll = tracksShownAll[project.id] ?? false;
                const visibleTracks = showAll
                  ? project.tracks
                  : project.tracks.slice(0, TRACKS_SHOWN);
                const renaming = renamingProjectId === project.id;
                const menuOpen = menuProjectId === project.id;

                return (
                  <div className="project-group" key={project.id}>
                    <div className={`project-row${menuOpen ? " menu-open" : ""}`}>
                      <button
                        type="button"
                        className="project-main"
                        onClick={() => {
                          if (renaming) return;
                          setExpandedProjects({
                            ...expandedProjects,
                            [project.id]: collapsed,
                          });
                        }}
                      >
                        <span className="row-icon">
                          <IconFolder />
                        </span>
                        {renaming ? (
                          <input
                            className="rename-input"
                            autoFocus
                            value={renameValue}
                            onChange={(event) =>
                              setRenameValue(event.currentTarget.value)
                            }
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                setRenamingProjectId(null);
                                if (renameValue.trim()) {
                                  setProjectMeta(project.id, {
                                    displayName: renameValue,
                                  });
                                }
                              }
                              if (event.key === "Escape") {
                                setRenamingProjectId(null);
                              }
                            }}
                            onBlur={() => setRenamingProjectId(null)}
                          />
                        ) : (
                          <span className="project-name">
                            {project.displayName}
                            {project.archived ? "（已归档）" : ""}
                          </span>
                        )}
                      </button>

                      <div className="hover-controls">
                        <button
                          type="button"
                          className="mini-icon"
                          title={collapsed ? "展开轨道" : "收起轨道"}
                          onClick={() =>
                            setExpandedProjects({
                              ...expandedProjects,
                              [project.id]: collapsed,
                            })
                          }
                        >
                          <IconChevron open={!collapsed} />
                        </button>
                        <button
                          type="button"
                          className="mini-icon"
                          title="项目选项"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() =>
                            setMenuProjectId(menuOpen ? null : project.id)
                          }
                        >
                          <IconDots />
                        </button>
                      </div>

                      {menuOpen && (
                        <div
                          className="menu"
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setMenuProjectId(null);
                              setProjectMeta(project.id, { pinned: !project.pinned });
                            }}
                          >
                            <span className="row-icon">
                              <IconPin />
                            </span>
                            {project.pinned ? "取消置顶" : "置顶项目"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMenuProjectId(null);
                              revealInFinder(project.id);
                            }}
                          >
                            <span className="row-icon">
                              <IconFolder />
                            </span>
                            在 Finder 中显示
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMenuProjectId(null);
                              setRenameValue(project.displayName);
                              setRenamingProjectId(project.id);
                            }}
                          >
                            <span className="row-icon">
                              <IconPencil />
                            </span>
                            重命名项目
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMenuProjectId(null);
                              setProjectMeta(project.id, {
                                archived: !project.archived,
                              });
                            }}
                          >
                            <span className="row-icon">
                              <IconArchive />
                            </span>
                            {project.archived ? "取消归档" : "归档项目"}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className={`track-fold${collapsed ? " folded" : ""}`}>
                      <div className="track-list">
                        {visibleTracks.map((track) => (
                          <button
                            type="button"
                            key={track.id}
                            className={`track-row${
                              project.id === state?.currentProjectId &&
                              track.id === state?.currentTrack?.id
                                ? " selected"
                                : ""
                            }`}
                            disabled={busy}
                            onClick={() => selectTrack(project.id, track.id)}
                          >
                            <span className="track-title">{track.title}</span>
                            <span className="track-count">{track.exerciseCount} 题</span>
                          </button>
                        ))}
                        {project.tracks.length > TRACKS_SHOWN && (
                          <button
                            type="button"
                            className="track-expand"
                            onClick={() =>
                              setTracksShownAll({
                                ...tracksShownAll,
                                [project.id]: !showAll,
                              })
                            }
                          >
                            {showAll ? "收起" : "展开显示"}
                          </button>
                        )}
                        {!project.tracks.length && (
                          <p className="empty-text">
                            还没有轨道。让 Claude Code 或 Codex 帮你建一条。
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {!state?.projects.length && (
                <p className="empty-text">
                  还没有练习项目。在项目目录里放一份 tracekata.json 就会出现在这里。
                </p>
              )}
            </div>

            <footer className="sidebar-foot">
              <button
                type="button"
                className="nav-row"
                title={state?.workspaceRoot}
                onClick={async () => {
                  setError("");
                  setMessage("");
                  try {
                    const result = await invoke<CommandResult>(
                      "open_workspace_in_vscode",
                    );
                    setMessage(result.message);
                  } catch (caught) {
                    setError(String(caught));
                  }
                }}
              >
                <span className="row-icon">
                  <IconCode />
                </span>
                在 VSCode 中打开
              </button>
            </footer>
          </div>
        </div>
      </aside>

      {view === "exercise" && (
        <nav className="exercise-column">
          <p className="section-label">{state?.currentTrack?.title ?? "练习"}</p>
          <div className="exercise-list">
            {state?.trackExercises.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`exercise-row${item.id === exerciseId ? " selected" : ""}`}
                onClick={() => selectExercise(item.id)}
              >
                <span className="exercise-id">{item.id}</span>
                <span className="exercise-title">{item.title}</span>
                <span className="exercise-mark">
                  {item.finished ? "✓" : item.id === exerciseId ? "●" : ""}
                </span>
              </button>
            ))}
            {!state?.trackExercises.length && (
              <p className="empty-text">这条轨道还没有练习。</p>
            )}
          </div>
        </nav>
      )}

      <section className="detail">
        {error && <p className="notice error">{error}</p>}
        {message && <p className="notice">{message}</p>}

        {view === "exercise" && (
          <>
            <header className="detail-head">
              <h2>
                {current ? `${current.id} ${current.title}` : "还没有当前练习"}
              </h2>
              <p className="base-hint">{state?.baseHint}</p>
            </header>

            <div className="file-summary">
              {state?.fileGroups.map((group) => (
                <div className="file-group" key={group.kind}>
                  <h3>{groupNames[group.kind] ?? "文件"}</h3>
                  <div className="file-list">
                    {group.files.map((file) => (
                      <button
                        type="button"
                        className="file-row"
                        key={file.relativePath}
                        onClick={() => openFile(file.relativePath)}
                        title={file.relativePath}
                      >
                        <span className="file-name">{file.name}</span>
                        <FileStatus file={file} />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="action-row">
              <button
                type="button"
                className="main-button strong"
                disabled={busy}
                onClick={openScene}
              >
                打开练习现场
              </button>
              <button
                type="button"
                className="main-button"
                disabled={busy}
                onClick={() => call<RunResult>("run_exercise", setRunResult)}
              >
                运行练习
              </button>
            </div>

            <div className="run-panel">
              <p className="run-command">
                {runResult ? `> ${runResult.command}` : runText ? `> ${runText}` : ""}
                {runResult && runResult.status !== 0 && (
                  <span className="run-status">退出码 {runResult.status ?? "无"}</span>
                )}
              </p>
              <pre>
                {runResult
                  ? [runResult.stdout.trim(), runResult.stderr.trim()]
                      .filter(Boolean)
                      .join("\n") || "没有输出，可能练习文件还没写内容。"
                  : "点「运行练习」，结果显示在这里。"}
              </pre>
            </div>
          </>
        )}

        {view === "memo" && (
          <>
            <header className="detail-head">
              <h2>锚点记录</h2>
              <p className="base-hint">
                {currentProject
                  ? `记录在 ${currentProject.displayName} 项目里。只记你自己真的想明白的那句话。`
                  : "只记你自己真的想明白的那句话。"}
              </p>
            </header>

            <div className="memo-form">
              <input
                value={memoTitle}
                onChange={(event) => setMemoTitle(event.currentTarget.value)}
                placeholder="标题，比如：函数参数不是变量名绑定"
              />
              <textarea
                value={memoBody}
                onChange={(event) => setMemoBody(event.currentTarget.value)}
                placeholder="写你刚刚真正想明白的那句话"
                rows={3}
              />
              <div className="memo-form-foot">
                <input
                  value={memoTags}
                  onChange={(event) => setMemoTags(event.currentTarget.value)}
                  placeholder="标签，比如：函数 参数"
                />
                <button
                  type="button"
                  className="main-button strong"
                  disabled={busy}
                  onClick={saveMemo}
                >
                  保存
                </button>
              </div>
            </div>

            <div className="memo-list">
              {state?.memos.length ? (
                state.memos.map((memo) => (
                  <article className="memo-card" key={`${memo.time}-${memo.title}`}>
                    <time>{memo.time || "未记录时间"}</time>
                    <h3>{memo.title}</h3>
                    <p>{memo.body}</p>
                    {memo.tags.length > 0 && (
                      <div className="tag-row">
                        {memo.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    )}
                  </article>
                ))
              ) : (
                <p className="empty-text">
                  还没有记录。卡住、想通、修对了，才适合写这里。
                </p>
              )}
            </div>
          </>
        )}

        {view === "skills" && (
          <>
            <header className="detail-head">
              <h2>AI 能做什么</h2>
              <p className="base-hint">
                这些是本机已安装的 AI 技能，共 {state?.aiSkills.length ?? 0} 个。
              </p>
            </header>

            <div className="skill-list">
              {state?.aiSkills.length ? (
                state.aiSkills.map((skill) => (
                  <article className="skill-card" key={skill.path}>
                    <div>
                      <strong>{skill.name}</strong>
                      <span>{skill.source}</span>
                    </div>
                    <p>{skill.description || "这个技能没有写说明。"}</p>
                  </article>
                ))
              ) : (
                <p className="empty-text">没有扫描到技能文件。</p>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function FileStatus({ file }: { file: FileItem }) {
  if (!file.exists) {
    return <span className="status warn">未创建</span>;
  }

  if (file.isEmpty) {
    return <span className="status quiet">空白</span>;
  }

  return <span className="status">{file.lineCount} 行</span>;
}

export default App;
