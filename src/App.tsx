import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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

type CliDetection = {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
};

type ChatEngine = "claude" | "codex";

type ModelOption = {
  id: string;
  label: string;
};

type ChatStreamEvent = {
  kind: string;
  delta?: string;
  toolName?: string;
  toolInput?: string;
  sessionId?: string;
  error?: string;
};

type ChatTool = { name: string; result?: string };

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  thinking: string;
  tools: ChatTool[];
};

type ChatSessionInfo = {
  sessionId: string;
  title: string;
  updatedAt: number;
  engine: ChatEngine;
};

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

// 引擎/模型选择常驻（localStorage，按引擎分别记忆）
const ENGINE_KEY = "tracekata.chatEngine";
const modelKey = (engine: ChatEngine) => `tracekata.chatModel.${engine}`;

function savedEngine(): ChatEngine {
  return localStorage.getItem(ENGINE_KEY) === "codex" ? "codex" : "claude";
}

function savedModel(engine: ChatEngine): string {
  return localStorage.getItem(modelKey(engine)) || "default";
}

function formatSessionTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

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

function IconCaret({ open }: { open: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 0.18s ease",
      }}
    >
      <polyline points="6,3 11,8 6,13" />
    </svg>
  );
}

function IconArrowLeft() {
  return (
    <svg {...iconProps}>
      <line x1="13" y1="8" x2="3" y2="8" />
      <polyline points="7,4 3,8 7,12" />
    </svg>
  );
}

/* Claude / OpenAI 品牌标（来自 open-design 的 agent-icons） */
function IconClaude({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path
        fill="#d97757"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0v-3.1h3V5h17.998zM6 10.949h1.488V8.102H6zm10.51 0H18V8.102h-1.49z"
      />
    </svg>
  );
}

function IconOpenAI({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z" />
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

function IconChat() {
  return (
    <svg {...iconProps}>
      <path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 10H6l-3 2.5V10H4a1.5 1.5 0 0 1-1.5-1.5v-4z" />
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
  const [cliDetection, setCliDetection] = useState<CliDetection | null>(null);
  const [detecting, setDetecting] = useState(false);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatResumeId, setChatResumeId] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSessionInfo[]>([]);
  const [panelView, setPanelView] = useState<"sessions" | "conversation">("sessions");
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [chatEngine, setChatEngine] = useState<ChatEngine>(savedEngine);
  const [chatModel, setChatModel] = useState(() => savedModel(savedEngine()));
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [chatOpen, setChatOpen] = useState(true);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  async function detectCli(engine: ChatEngine = chatEngine) {
    setDetecting(true);
    try {
      const result = await invoke<CliDetection>(
        engine === "codex" ? "detect_codex_cli" : "detect_claude_cli",
      );
      setCliDetection(result);
    } catch (caught) {
      setCliDetection({ available: false, error: String(caught) });
    } finally {
      setDetecting(false);
    }
  }

  async function loadModels(engine: ChatEngine) {
    try {
      const list = await invoke<ModelOption[]>("list_models", {
        engine,
        cwd: state?.workspaceRoot ?? null,
      });
      setModelOptions(list);
    } catch {
      setModelOptions([{ id: "default", label: "默认" }]);
    }
  }

  function applyEngine(engine: ChatEngine) {
    setChatEngine(engine);
    localStorage.setItem(ENGINE_KEY, engine);
    // 恢复这个引擎上次选的型号
    setChatModel(savedModel(engine));
    detectCli(engine);
    loadModels(engine);
  }

  function switchEngine(engine: ChatEngine) {
    if (chatStreaming || engine === chatEngine) return;
    applyEngine(engine);
    // 会话不能跨引擎接续，切引擎从新会话开始
    setChatMessages([]);
    setChatResumeId(null);
  }

  async function loadChatSessions() {
    if (!state?.workspaceRoot) return;
    try {
      const list = await invoke<ChatSessionInfo[]>("list_chat_sessions", {
        cwd: state.workspaceRoot,
      });
      setChatSessions(list);
    } catch {
      // 没有会话目录也正常，静默
    }
  }

  function newChat() {
    setChatMessages([]);
    setChatResumeId(null);
    setChatInput("");
    setSessionTitle(null);
    setPanelView("conversation");
  }

  function backToSessions() {
    setPanelView("sessions");
    loadChatSessions();
  }

  async function resumeSession(session: ChatSessionInfo) {
    if (chatStreaming) return;
    if (session.engine !== chatEngine) applyEngine(session.engine);
    setChatResumeId(session.sessionId);
    setSessionTitle(session.title);
    setChatInput("");
    setPanelView("conversation");
    try {
      const history = await invoke<ChatMessage[]>("load_chat_history", {
        cwd: state?.workspaceRoot ?? "",
        sessionId: session.sessionId,
        engine: session.engine,
      });
      setChatMessages(history);
    } catch (caught) {
      setError(String(caught));
    }
  }

  // 对话栏打开且工作区就绪时，初始化 CLI 探测，并实时刷新模型/会话列表
  useEffect(() => {
    if (!chatOpen || !state?.workspaceRoot) return;
    if (!cliDetection) detectCli();
    loadModels(chatEngine);
    loadChatSessions();
  }, [chatOpen, state?.workspaceRoot]);

  // 监听后端流式事件，累积到最后一条 assistant 消息
  useEffect(() => {
    const unlisten = listen<ChatStreamEvent>("chat-stream", (event) => {
      const e = event.payload;
      setChatMessages((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const last = { ...next[next.length - 1] };
        if (last.role !== "assistant") return prev;

        if (e.kind === "text" && e.delta) {
          last.content += e.delta;
        } else if (e.kind === "thinking" && e.delta) {
          last.thinking += e.delta;
        } else if (e.kind === "tool_use" && e.toolName) {
          last.tools = [...last.tools, { name: e.toolName }];
        } else if (e.kind === "tool_result") {
          const tools = [...last.tools];
          for (let i = tools.length - 1; i >= 0; i--) {
            if (!tools[i].result) {
              tools[i] = { ...tools[i], result: e.toolInput || "完成" };
              break;
            }
          }
          last.tools = tools;
        } else if (e.kind === "error" && e.error) {
          last.content += `\n\n⚠️ ${e.error}`;
        }
        next[next.length - 1] = last;
        return next;
      });

      if (e.kind === "status" && e.sessionId) {
        setChatResumeId(e.sessionId);
      }
      if (e.kind === "done") {
        if (e.sessionId) setChatResumeId(e.sessionId);
        setChatStreaming(false);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 新消息时滚到底
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight });
  }, [chatMessages]);

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatStreaming) return;
    setChatInput("");
    setChatStreaming(true);
    // 新会话用第一条消息当标题（顶栏显示）
    setSessionTitle((prev) => prev ?? [...text].slice(0, 40).join(""));
    setChatMessages((prev) => [
      ...prev,
      { role: "user", content: text, thinking: "", tools: [] },
      { role: "assistant", content: "", thinking: "", tools: [] },
    ]);
    try {
      await invoke("send_chat_message", {
        message: text,
        resumeId: chatResumeId,
        cwd: state?.workspaceRoot ?? null,
        engine: chatEngine,
        model: chatModel,
      });
      loadChatSessions();
    } catch (caught) {
      setChatMessages((prev) => {
        const next = [...prev];
        const last = { ...next[next.length - 1] };
        last.content += `\n\n⚠️ ${String(caught)}`;
        next[next.length - 1] = last;
        return next;
      });
      setChatStreaming(false);
    }
  }

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
              <button
                type="button"
                className={`nav-row${chatOpen ? " active" : ""}`}
                onClick={() => setChatOpen((v) => !v)}
              >
                <span className="row-icon">
                  <IconChat />
                </span>
                AI 对话
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
                        <span className="tree-caret">
                          <IconCaret open={!collapsed} />
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
                        {visibleTracks.map((track) => {
                          const isCurrent =
                            project.id === state?.currentProjectId &&
                            track.id === state?.currentTrack?.id;
                          return (
                            <div key={track.id}>
                              <button
                                type="button"
                                className={`track-row${isCurrent ? " selected" : ""}`}
                                disabled={busy}
                                onClick={() => selectTrack(project.id, track.id)}
                              >
                                <span className="tree-caret">
                                  <IconCaret open={isCurrent} />
                                </span>
                                <span className="track-title">{track.title}</span>
                                <span className="track-count">
                                  {track.exerciseCount}
                                </span>
                              </button>
                              {isCurrent && (
                                <div className="exercise-tree">
                                  {state?.trackExercises.map((item) => (
                                    <button
                                      type="button"
                                      key={item.id}
                                      className={`exercise-row${
                                        item.id === exerciseId ? " selected" : ""
                                      }`}
                                      onClick={() => selectExercise(item.id)}
                                    >
                                      <span className="exercise-id">{item.id}</span>
                                      <span className="exercise-title">
                                        {item.title}
                                      </span>
                                      {item.finished && (
                                        <span
                                          className="exercise-done"
                                          title="已完成"
                                        />
                                      )}
                                    </button>
                                  ))}
                                  {!state?.trackExercises.length && (
                                    <p className="empty-text">
                                      这条轨道还没有练习。
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
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

      {chatOpen && (
        <aside className="chat-panel">
            <header className="chat-head">
              {panelView === "conversation" ? (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    title="返回会话列表"
                    onClick={backToSessions}
                  >
                    <IconArrowLeft />
                  </button>
                  <span className="session-engine">
                    {chatEngine === "codex" ? <IconOpenAI /> : <IconClaude />}
                  </span>
                  <h2 className="chat-session-title" title={sessionTitle ?? "新对话"}>
                    {sessionTitle ?? "新对话"}
                  </h2>
                </>
              ) : (
                <div className="chat-head-text">
                  <h2>会话</h2>
                  <p className="base-hint">
                    代理 7890 · {detecting ? "检测中…" : `共 ${chatSessions.length} 条`}
                  </p>
                </div>
              )}
              <button
                type="button"
                className="icon-button"
                title="新对话"
                onClick={newChat}
              >
                <svg {...iconProps}>
                  <line x1="8" y1="3" x2="8" y2="13" />
                  <line x1="3" y1="8" x2="13" y2="8" />
                </svg>
              </button>
              <button
                type="button"
                className="icon-button"
                title="收起对话栏"
                onClick={() => setChatOpen(false)}
              >
                <svg {...iconProps}>
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </header>

            {panelView === "sessions" ? (
              <div className="session-list">
                {chatSessions.length === 0 ? (
                  <p className="empty-text">还没有会话，点右上角 ＋ 开始。</p>
                ) : (
                  chatSessions.map((s) => (
                    <button
                      key={`${s.engine}-${s.sessionId}`}
                      type="button"
                      className={
                        "session-row" + (s.sessionId === chatResumeId ? " active" : "")
                      }
                      onClick={() => resumeSession(s)}
                    >
                      <span className="session-engine">
                        {s.engine === "codex" ? <IconOpenAI /> : <IconClaude />}
                      </span>
                      <span className="session-title">{s.title}</span>
                      <span className="session-time">
                        {formatSessionTime(s.updatedAt)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : cliDetection && !cliDetection.available ? (
              <div className="cli-card bad">
                <strong>
                  ✗ 未检测到 {chatEngine === "codex" ? "Codex" : "Claude Code"} CLI
                </strong>
                <p>{cliDetection.error}</p>
                <button type="button" className="main-button" onClick={() => detectCli()}>
                  重新检测
                </button>
              </div>
            ) : (
              <>
                {!chatResumeId && chatMessages.length === 0 && (
                  <div className="chat-toolbar">
                    <div className="engine-switch">
                      <button
                        type="button"
                        className={chatEngine === "claude" ? "active" : ""}
                        disabled={chatStreaming}
                        onClick={() => switchEngine("claude")}
                      >
                        <IconClaude size={12} /> Claude
                      </button>
                      <button
                        type="button"
                        className={chatEngine === "codex" ? "active" : ""}
                        disabled={chatStreaming}
                        onClick={() => switchEngine("codex")}
                      >
                        <IconOpenAI size={12} /> Codex
                      </button>
                    </div>
                  </div>
                )}
                <div className="chat-scroll" ref={chatScrollRef}>
                  {chatMessages.length === 0 && (
                    <p className="empty-text">
                      和 AI 聊聊当前练习。它能联网搜索、读工作区文件。
                    </p>
                  )}
                  {chatMessages.map((msg, i) => (
                    <ChatBubble
                      key={i}
                      msg={msg}
                      streaming={chatStreaming && i === chatMessages.length - 1}
                    />
                  ))}
                </div>

                <div className="chat-input-card">
                  <textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendChat();
                      }
                    }}
                    placeholder={
                      chatStreaming
                        ? `${chatEngine === "codex" ? "Codex" : "Claude"} 正在回复…`
                        : "输入消息，Enter 发送，Shift+Enter 换行"
                    }
                    rows={2}
                    disabled={chatStreaming}
                  />
                  <div className="chat-input-foot">
                    <select
                      className="model-select"
                      value={chatModel}
                      disabled={chatStreaming}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setChatModel(value);
                        localStorage.setItem(modelKey(chatEngine), value);
                      }}
                    >
                      {modelOptions.length === 0 && (
                        <option value="default">默认</option>
                      )}
                      {modelOptions.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                      {chatModel !== "default" &&
                        !modelOptions.some((m) => m.id === chatModel) && (
                          <option value={chatModel}>{chatModel}</option>
                        )}
                    </select>
                    <button
                      type="button"
                      className="send-btn"
                      title="发送"
                      disabled={chatStreaming || !chatInput.trim()}
                      onClick={sendChat}
                    >
                      <svg
                        width={14}
                        height={14}
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="8" y1="13" x2="8" y2="3" />
                        <polyline points="4,7 8,3 12,7" />
                      </svg>
                    </button>
                  </div>
                </div>
              </>
            )}
        </aside>
      )}
    </main>
  );
}

function ChatBubble({ msg, streaming }: { msg: ChatMessage; streaming: boolean }) {
  if (msg.role === "user") {
    return (
      <div className="chat-bubble user">
        <div className="bubble-body">{msg.content}</div>
      </div>
    );
  }

  return (
    <div className="chat-bubble assistant">
      {msg.thinking && (
        <details className="bubble-thinking">
          <summary>思考过程</summary>
          <pre>{msg.thinking}</pre>
        </details>
      )}
      {msg.tools.map((tool, i) => (
        <div className="bubble-tool" key={i}>
          <span className="tool-name">{tool.name}</span>
          {tool.result ? (
            <span className="tool-done">✓</span>
          ) : (
            <span className="tool-running">运行中…</span>
          )}
        </div>
      ))}
      <div className="bubble-body md">
        {msg.content ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        ) : (
          streaming && <span className="typing">●●●</span>
        )}
      </div>
    </div>
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
