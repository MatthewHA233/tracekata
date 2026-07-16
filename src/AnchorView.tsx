// ══════════════════════════════════════════════
// 锚点记录视图 — 对着代码语境说想法 → AI 锚定 → 锚点域地图
//   · 记录 tab：语境文件 + 框选片段 + 原话输入 → extract_anchor → 确认保存
//   · 锚点域 tab：增量嵌入 → PCA 投影 + 余弦聚簇 → SVG 地图（球=锚点句、山=AI 命名簇）
//   · 服务设置存 localStorage，API 默认直连 DashScope（不走代理）
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  clusterByCosine,
  clusterMemberHash,
  projectAnchors,
} from "./lib/anchor-layout";

type AnchorItem = {
  id: string;
  keyword: string;
  category: string;
  createdAt: string;
};

type AnchorBinding = {
  id: string;
  projectId: string;
  exerciseId: string;
  contextLabel: string;
  segment: string;
  userSpeech: string;
  thought: string;
  anchorIds: string[];
  createdAt: string;
};

type FieldData = {
  anchors: AnchorItem[];
  bindings: AnchorBinding[];
  embeddings: Record<string, number[]>;
  clusterNames: Record<string, string>;
};

type ExtractResult = {
  worth: boolean;
  segment: string;
  thought: string;
  anchors: Array<{ keyword: string; category: string }>;
};

type ServiceSettings = {
  apiBase: string;
  apiKey: string;
  extractVia: "claude" | "codex" | "api";
  extractModel: string;
  embedModel: string;
};

type FileRef = { name: string; relativePath: string; exists: boolean };

export type AnchorViewProps = {
  projectId: string | null;
  exerciseId: string;
  exerciseTitle: string;
  fileGroups: Array<{ kind: string; files: FileRef[] }>;
  memos: Array<{ title: string; body: string; time: string; tags: string[] }>;
};

const SERVICE_KEY = "tracekata.anchorService";

const DEFAULT_SERVICE: ServiceSettings = {
  apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "",
  extractVia: "claude",
  extractModel: "qwen-flash",
  embedModel: "text-embedding-v4",
};

function loadService(): ServiceSettings {
  try {
    const raw = localStorage.getItem(SERVICE_KEY);
    if (raw) return { ...DEFAULT_SERVICE, ...(JSON.parse(raw) as Partial<ServiceSettings>) };
  } catch {
    // 配置损坏就回默认
  }
  return { ...DEFAULT_SERVICE };
}

const CAT_META: Record<string, { label: string; className: string }> = {
  motive: { label: "动机", className: "motive" },
  view: { label: "观点", className: "view" },
  practice: { label: "实践", className: "practice" },
};

const GROUP_NAMES: Record<string, string> = {
  practice: "手敲",
  reference: "题目",
  base: "基底",
  demo: "示范",
};

const WORLD = { w: 900, h: 560, pad: 64 } as const;

export default function AnchorView({
  projectId,
  exerciseId,
  exerciseTitle,
  fileGroups,
  memos,
}: AnchorViewProps) {
  const [tab, setTab] = useState<"record" | "map">("record");
  const [service, setService] = useState<ServiceSettings>(loadService);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [field, setField] = useState<FieldData | null>(null);
  const [notice, setNotice] = useState("");

  // ── 记录 tab 状态 ──
  const [ctxFile, setCtxFile] = useState<FileRef | null>(null);
  const [ctxText, setCtxText] = useState("");
  const [selText, setSelText] = useState("");
  const [speech, setSpeech] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [pending, setPending] = useState<ExtractResult | null>(null);

  // ── 地图 tab 状态 ──
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [clusters, setClusters] = useState<string[][]>([]);
  const [clusterLabels, setClusterLabels] = useState<Record<string, string>>({});
  const [mapBusy, setMapBusy] = useState(false);
  const [mapError, setMapError] = useState("");
  const [focusAnchorId, setFocusAnchorId] = useState<string | null>(null);
  const mapBuilding = useRef(false);

  function updateService(patch: Partial<ServiceSettings>) {
    setService((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(SERVICE_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function reloadField() {
    try {
      setField(await invoke<FieldData>("load_anchor_field"));
    } catch (caught) {
      setNotice(String(caught));
    }
  }

  useEffect(() => {
    reloadField();
  }, []);

  // 切换练习时清掉语境选择
  useEffect(() => {
    setCtxFile(null);
    setCtxText("");
    setSelText("");
    setPending(null);
  }, [projectId, exerciseId]);

  async function openContextFile(file: FileRef) {
    if (!projectId) return;
    setCtxFile(file);
    setSelText("");
    try {
      const text = await invoke<string>("read_project_file", {
        projectId,
        relativePath: file.relativePath,
      });
      setCtxText(text);
    } catch (caught) {
      setCtxText("");
      setNotice(String(caught));
    }
  }

  function captureSelection() {
    const sel = window.getSelection()?.toString() ?? "";
    if (sel.trim().length >= 8) setSelText(sel.trim());
  }

  async function runExtract() {
    const text = speech.trim();
    if (!text) return;
    setExtracting(true);
    setNotice("");
    setPending(null);
    try {
      const result = await invoke<ExtractResult>("extract_anchor", {
        settings: service,
        contextText: selText || ctxText,
        userSpeech: text,
      });
      if (!result.worth) {
        setNotice("这句话没被判定为值得记录（提问、指令、闲聊不记）。换成你的真实想法再试。");
      } else {
        setPending(result);
      }
    } catch (caught) {
      setNotice(String(caught));
    } finally {
      setExtracting(false);
    }
  }

  async function saveRecord() {
    if (!pending) return;
    const label = [
      exerciseId && exerciseTitle ? `${exerciseId} ${exerciseTitle}` : "",
      ctxFile?.name ?? "",
    ]
      .filter(Boolean)
      .join(" · ");
    try {
      await invoke("save_anchor_record", {
        projectId: projectId ?? "",
        exerciseId,
        contextLabel: label || "无语境",
        segment: pending.segment,
        userSpeech: speech.trim(),
        thought: pending.thought,
        anchors: pending.anchors,
      });
      setPending(null);
      setSpeech("");
      setNotice("已锚定。");
      await reloadField();
      // 有 key 就顺手补向量，失败不打扰（打开地图时会重试）
      if (service.apiKey) {
        invoke("embed_missing_anchors", { settings: service }).catch(() => {});
      }
    } catch (caught) {
      setNotice(String(caught));
    }
  }

  // ── 地图构建 ──
  useEffect(() => {
    if (tab !== "map" || mapBuilding.current) return;
    mapBuilding.current = true;
    (async () => {
      setMapBusy(true);
      setMapError("");
      try {
        let data = await invoke<FieldData>("load_anchor_field");
        if (service.apiKey) {
          try {
            const added = await invoke<number>("embed_missing_anchors", {
              settings: service,
            });
            if (added > 0) data = await invoke<FieldData>("load_anchor_field");
          } catch (caught) {
            setMapError(String(caught));
          }
        }
        setField(data);

        const entries = data.anchors
          .filter((a) => Array.isArray(data.embeddings[a.id]))
          .map((a) => ({ id: a.id, vector: data.embeddings[a.id] }));
        setPositions(projectAnchors(entries, WORLD));
        const groups = clusterByCosine(entries);
        setClusters(groups);

        // 簇命名：缓存命中直接用；未命中 AI 起名并写缓存；失败回退首句（不缓存）
        const byId = new Map(data.anchors.map((a) => [a.id, a]));
        const labels: Record<string, string> = {};
        for (const group of groups) {
          if (group.length < 2) continue;
          const hash = clusterMemberHash(group);
          const cached = data.clusterNames[hash];
          if (cached) {
            labels[hash] = cached;
            continue;
          }
          const keywords = group
            .map((id) => byId.get(id)?.keyword)
            .filter((k): k is string => Boolean(k));
          try {
            const name = await invoke<string>("name_cluster", {
              settings: service,
              keywords,
            });
            labels[hash] = name;
            await invoke("save_cluster_name", { memberHash: hash, name });
          } catch {
            labels[hash] = keywords[0] ?? "未命名";
          }
          setClusterLabels({ ...labels });
        }
        setClusterLabels(labels);
      } catch (caught) {
        setMapError(String(caught));
      } finally {
        setMapBusy(false);
        mapBuilding.current = false;
      }
    })();
  }, [tab]);

  const anchorById = useMemo(
    () => new Map((field?.anchors ?? []).map((a) => [a.id, a])),
    [field],
  );

  const focusAnchor = focusAnchorId ? anchorById.get(focusAnchorId) : null;
  const focusBindings = useMemo(() => {
    if (!focusAnchorId || !field) return [];
    return field.bindings.filter((b) => b.anchorIds.includes(focusAnchorId));
  }, [focusAnchorId, field]);

  const sortedBindings = useMemo(
    () => [...(field?.bindings ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [field],
  );

  const embeddedCount = field
    ? field.anchors.filter((a) => field.embeddings[a.id]).length
    : 0;
  const allFiles = fileGroups.flatMap((g) =>
    g.files.filter((f) => f.exists).map((f) => ({ ...f, kind: g.kind })),
  );

  return (
    <>
      <header className="detail-head">
        <h2>锚点记录</h2>
        <p className="base-hint">
          对着代码语境说出你的想法，AI 提取锚点句；语义相近的锚点会在地图上聚成山。
        </p>
      </header>

      <div className="anchor-tabs">
        <div className="engine-switch">
          <button
            type="button"
            className={tab === "record" ? "active" : ""}
            onClick={() => setTab("record")}
          >
            记录
          </button>
          <button
            type="button"
            className={tab === "map" ? "active" : ""}
            onClick={() => setTab("map")}
          >
            锚点域
          </button>
        </div>
        <button
          type="button"
          className="sessions-toggle"
          onClick={() => setSettingsOpen((v) => !v)}
        >
          服务设置 {settingsOpen ? "▾" : "▸"}
        </button>
      </div>

      {settingsOpen && (
        <div className="anchor-settings">
          <label>
            提取通道
            <select
              value={service.extractVia}
              onChange={(e) =>
                updateService({ extractVia: e.currentTarget.value as ServiceSettings["extractVia"] })
              }
            >
              <option value="claude">Claude Code CLI（走 7890）</option>
              <option value="codex">Codex CLI（走 7890）</option>
              <option value="api">API（直连，下方配置）</option>
            </select>
          </label>
          <label>
            API Base
            <input
              value={service.apiBase}
              onChange={(e) => updateService({ apiBase: e.currentTarget.value })}
              placeholder={DEFAULT_SERVICE.apiBase}
            />
          </label>
          <label>
            API Key（嵌入向量必需）
            <input
              type="password"
              value={service.apiKey}
              onChange={(e) => updateService({ apiKey: e.currentTarget.value })}
              placeholder="sk-…"
            />
          </label>
          <div className="anchor-settings-row">
            <label>
              提取模型（API 通道用）
              <input
                value={service.extractModel}
                onChange={(e) => updateService({ extractModel: e.currentTarget.value })}
              />
            </label>
            <label>
              嵌入模型
              <input
                value={service.embedModel}
                onChange={(e) => updateService({ embedModel: e.currentTarget.value })}
              />
            </label>
          </div>
        </div>
      )}

      {notice && <p className="notice">{notice}</p>}

      {tab === "record" && (
        <>
          <div className="ctx-card">
            <div className="ctx-files">
              <span className="ctx-label">语境</span>
              {allFiles.length === 0 && (
                <span className="empty-text">当前练习没有可用文件。</span>
              )}
              {allFiles.map((f) => (
                <button
                  key={f.relativePath}
                  type="button"
                  className={`chip${ctxFile?.relativePath === f.relativePath ? " active" : ""}`}
                  onClick={() => openContextFile(f)}
                >
                  <span className="chip-kind">{GROUP_NAMES[f.kind] ?? "文件"}</span>
                  {f.name}
                </button>
              ))}
            </div>
            {ctxFile && (
              <pre className="ctx-pre" onMouseUp={captureSelection}>
                {ctxText || "（空文件）"}
              </pre>
            )}
            {selText && (
              <div className="ctx-selection">
                已框选 {selText.length} 字作为语境片段
                <button type="button" onClick={() => setSelText("")}>
                  清除
                </button>
              </div>
            )}
          </div>

          <div className="anchor-speech">
            <textarea
              value={speech}
              onChange={(e) => setSpeech(e.currentTarget.value)}
              rows={3}
              placeholder="对着上面的语境说出你的想法：想通了什么、下了什么判断、冒出了什么冲动…"
            />
            <button
              type="button"
              className="main-button strong"
              disabled={extracting || !speech.trim()}
              onClick={runExtract}
            >
              {extracting ? "锚定中…" : "锚定"}
            </button>
          </div>

          {pending && (
            <div className="anchor-pending">
              {pending.segment && (
                <blockquote className="pending-segment">{pending.segment}</blockquote>
              )}
              <p className="pending-thought">{pending.thought}</p>
              <div className="anchor-chip-row">
                {pending.anchors.map((a) => (
                  <span
                    key={`${a.category}-${a.keyword}`}
                    className={`anchor-chip ${CAT_META[a.category]?.className ?? ""}`}
                  >
                    <i />
                    {a.keyword}
                  </span>
                ))}
                {pending.anchors.length === 0 && (
                  <span className="empty-text">没提出锚点句（只存想法卡）。</span>
                )}
              </div>
              <div className="pending-actions">
                <button type="button" className="main-button strong" onClick={saveRecord}>
                  保存
                </button>
                <button type="button" className="main-button" onClick={() => setPending(null)}>
                  放弃
                </button>
              </div>
            </div>
          )}

          <div className="binding-list">
            {sortedBindings.map((b) => (
              <article className="binding-card" key={b.id}>
                <div className="binding-meta">
                  <span>{b.contextLabel}</span>
                  <time>{b.createdAt.replace("T", " ")}</time>
                </div>
                {b.segment && <blockquote>{b.segment}</blockquote>}
                <p>{b.thought}</p>
                <div className="anchor-chip-row">
                  {b.anchorIds.map((id) => {
                    const a = anchorById.get(id);
                    if (!a) return null;
                    return (
                      <span
                        key={id}
                        className={`anchor-chip ${CAT_META[a.category]?.className ?? ""}`}
                      >
                        <i />
                        {a.keyword}
                      </span>
                    );
                  })}
                </div>
              </article>
            ))}
            {sortedBindings.length === 0 && (
              <p className="empty-text">还没有锚点记录。想通一件事，就对着语境说出来。</p>
            )}
          </div>

          {memos.length > 0 && (
            <details className="old-memos">
              <summary>旧格式记录（{memos.length}）</summary>
              {memos.map((memo) => (
                <article className="memo-card" key={`${memo.time}-${memo.title}`}>
                  <time>{memo.time || "未记录时间"}</time>
                  <h3>{memo.title}</h3>
                  <p>{memo.body}</p>
                </article>
              ))}
            </details>
          )}
        </>
      )}

      {tab === "map" && (
        <>
          <p className="map-status">
            {mapBusy
              ? "构建地图中…"
              : `${field?.anchors.length ?? 0} 个锚点 · ${
                  clusters.filter((c) => c.length >= 2).length
                } 座山 · 已嵌入 ${embeddedCount}/${field?.anchors.length ?? 0}`}
            {!service.apiKey && (
              <span className="map-warn">
                　未配置 API Key，无法生成向量——打开「服务设置」填入 DashScope Key。
              </span>
            )}
            {mapError && <span className="map-warn">　{mapError}</span>}
          </p>

          {positions.size > 0 ? (
            <div className="anchor-map-wrap">
              <svg
                className="anchor-map"
                viewBox={`0 0 ${WORLD.w} ${WORLD.h}`}
                onClick={() => setFocusAnchorId(null)}
              >
                {clusters
                  .filter((c) => c.length >= 2)
                  .map((group) => {
                    const pts = group
                      .map((id) => positions.get(id))
                      .filter((p): p is { x: number; y: number } => Boolean(p));
                    if (pts.length < 2) return null;
                    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
                    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
                    const r =
                      Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)), 12) + 34;
                    const hash = clusterMemberHash(group);
                    return (
                      <g key={hash}>
                        <circle className="cluster-bubble" cx={cx} cy={cy} r={r} />
                        <text className="cluster-name" x={cx} y={cy - r - 8}>
                          {clusterLabels[hash] ?? "…"}
                        </text>
                      </g>
                    );
                  })}
                {(field?.anchors ?? []).map((a) => {
                  const p = positions.get(a.id);
                  if (!p) return null;
                  const focused = focusAnchorId === a.id;
                  return (
                    <g key={a.id}>
                      <circle
                        className={`anchor-ball ${CAT_META[a.category]?.className ?? ""}${
                          focused ? " focused" : ""
                        }`}
                        cx={p.x}
                        cy={p.y}
                        r={focused ? 9 : 7}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusAnchorId(a.id);
                        }}
                      >
                        <title>{a.keyword}</title>
                      </circle>
                    </g>
                  );
                })}
              </svg>
            </div>
          ) : (
            !mapBusy && (
              <p className="empty-text">
                {field?.anchors.length
                  ? "锚点还没有向量。配置 API Key 后重新打开本页生成语义地图。"
                  : "还没有锚点。先去「记录」里锚定几条想法。"}
              </p>
            )
          )}

          {focusAnchor && (
            <div className="anchor-detail">
              <div className="anchor-chip-row">
                <span className={`anchor-chip ${CAT_META[focusAnchor.category]?.className ?? ""}`}>
                  <i />
                  {focusAnchor.keyword}
                </span>
                <span className="anchor-cat-label">
                  {CAT_META[focusAnchor.category]?.label ?? focusAnchor.category}
                </span>
              </div>
              {focusBindings.map((b) => (
                <article className="binding-card" key={b.id}>
                  <div className="binding-meta">
                    <span>{b.contextLabel}</span>
                    <time>{b.createdAt.replace("T", " ")}</time>
                  </div>
                  <p>{b.thought}</p>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
