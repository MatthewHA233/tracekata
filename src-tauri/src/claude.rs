// 内置 Claude Code 会话：检测 / 启动 / 流式解析 / 起名 / 代理
// 不用 PTY，用 tokio 子进程 + JSONL 流（参考 Disky 的实现）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// 默认代理（让 claude 子进程能联网；子进程不继承终端代理变量，必须显式注入）
const DEFAULT_PROXY: &str = "http://127.0.0.1:7890";

/// CLI 检测结果，返回给前端
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDetection {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// 找到 claude 可执行文件路径
fn resolve_claude_bin() -> Option<PathBuf> {
    // 1. 环境变量覆盖
    if let Ok(custom) = std::env::var("CLAUDE_BIN") {
        let p = PathBuf::from(&custom);
        if p.exists() {
            return Some(p);
        }
    }

    // 2. which 查找
    if let Ok(output) = std::process::Command::new("which").arg("claude").output() {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                if let Some(first) = text.lines().next() {
                    let trimmed = first.trim();
                    if !trimmed.is_empty() {
                        return Some(PathBuf::from(trimmed));
                    }
                }
            }
        }
    }

    // 3. 常见安装路径兜底
    let home = std::env::var("HOME").ok();
    let mut candidates: Vec<PathBuf> = vec![];
    if let Some(h) = home {
        let h = PathBuf::from(h);
        candidates.push(h.join(".bun/bin/claude"));
        candidates.push(h.join(".local/bin/claude"));
        candidates.push(h.join(".npm-global/bin/claude"));
        candidates.push(h.join("node_modules/.bin/claude"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/bin/claude"));

    candidates.into_iter().find(|c| c.exists())
}

/// 找到 codex 可执行文件路径
fn resolve_codex_bin() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("CODEX_BIN") {
        let p = PathBuf::from(&custom);
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(output) = std::process::Command::new("which").arg("codex").output() {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                if let Some(first) = text.lines().next() {
                    let trimmed = first.trim();
                    if !trimmed.is_empty() {
                        return Some(PathBuf::from(trimmed));
                    }
                }
            }
        }
    }

    let home = std::env::var("HOME").ok();
    let mut candidates: Vec<PathBuf> = vec![];
    if let Some(h) = home {
        let h = PathBuf::from(h);
        candidates.push(h.join(".bun/bin/codex"));
        candidates.push(h.join(".local/bin/codex"));
        candidates.push(h.join(".npm-global/bin/codex"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/codex"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
    candidates.push(PathBuf::from("/usr/bin/codex"));

    candidates.into_iter().find(|c| c.exists())
}

/// 跑 `<bin> --version` 探测 CLI 是否可用（claude / codex 通用）
async fn probe_cli(bin: Option<PathBuf>, missing_hint: &str) -> CliDetection {
    let bin = match bin {
        Some(b) => b,
        None => {
            return CliDetection {
                available: false,
                path: None,
                version: None,
                error: Some(missing_hint.into()),
            }
        }
    };

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    match tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            CliDetection {
                available: true,
                path: Some(bin.to_string_lossy().to_string()),
                version: Some(version),
                error: None,
            }
        }
        Ok(Ok(out)) => CliDetection {
            available: false,
            path: Some(bin.to_string_lossy().to_string()),
            version: None,
            error: Some(format!(
                "CLI 异常退出（{}），可能需要重装或升级",
                out.status
            )),
        },
        Ok(Err(e)) => CliDetection {
            available: false,
            path: Some(bin.to_string_lossy().to_string()),
            version: None,
            error: Some(format!("启动失败：{e}")),
        },
        Err(_) => CliDetection {
            available: false,
            path: Some(bin.to_string_lossy().to_string()),
            version: None,
            error: Some("检测超时（10 秒）".into()),
        },
    }
}

/// 检测 claude CLI 是否可用
#[tauri::command]
pub async fn detect_claude_cli() -> CliDetection {
    probe_cli(
        resolve_claude_bin(),
        "未找到 claude 可执行文件，请确认已安装 Claude Code CLI",
    )
    .await
}

/// 检测 codex CLI 是否可用
#[tauri::command]
pub async fn detect_codex_cli() -> CliDetection {
    probe_cli(
        resolve_codex_bin(),
        "未找到 codex 可执行文件，请确认已安装 Codex CLI（npm i -g @openai/codex）",
    )
    .await
}

/// 模型选项（下拉菜单用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

fn model(id: &str, label: &str) -> ModelOption {
    ModelOption {
        id: id.into(),
        label: label.into(),
    }
}

/// 解析 `codex debug models` 的 JSON 输出（{"models":[{slug,display_name,visibility}]}）
fn parse_codex_models(stdout: &[u8]) -> Option<Vec<ModelOption>> {
    let json: serde_json::Value = serde_json::from_slice(stdout).ok()?;
    let models = json.get("models")?.as_array()?;
    let mut out = vec![model("default", "默认")];
    for entry in models {
        // 实测 visibility 值是 "hide"（内部模型如 codex-auto-review），兼容 "hidden"
        if matches!(
            entry.get("visibility").and_then(|v| v.as_str()),
            Some("hide") | Some("hidden")
        ) {
            continue;
        }
        let id = entry
            .get("slug")
            .or_else(|| entry.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if id.is_empty() || out.iter().any(|m| m.id == id) {
            continue;
        }
        let label = entry
            .get("display_name")
            .or_else(|| entry.get("name"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(id);
        out.push(model(id, label));
    }
    (out.len() > 1).then_some(out)
}

/// 抽出字符串里所有 '单引号' 包住的 token
fn extract_quoted(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(i) = rest.find('\'') {
        let after = &rest[i + 1..];
        let Some(j) = after.find('\'') else { break };
        let token = &after[..j];
        if !token.is_empty()
            && token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        {
            out.push(token.to_string());
        }
        rest = &after[j + 1..];
    }
    out
}

/// 从 `claude --help` 的 --model 段落解析当前别名和示例模型名。
/// CLI 升级后帮助文本更新，列表自动跟进（如 2.1.208 给出 'fable'/'opus'/'sonnet'）。
async fn claude_models_from_help(bin: &PathBuf) -> (Vec<String>, Vec<String>) {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("--help").stdout(Stdio::piped()).stderr(Stdio::piped());
    let Ok(Ok(out)) =
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    else {
        return (vec![], vec![]);
    };
    let help = String::from_utf8_lossy(&out.stdout);
    let Some(start) = help.find("--model") else {
        return (vec![], vec![]);
    };
    let block = &help[start..];
    // 段落到下一个选项行（"\n  --"）为止
    let block = match block[7..].find("\n  --") {
        Some(end) => &block[..7 + end],
        None => block,
    };
    let mut aliases = Vec::new();
    let mut ids = Vec::new();
    for token in extract_quoted(block) {
        if token.starts_with("claude-") {
            if !ids.contains(&token) {
                ids.push(token);
            }
        } else if !aliases.contains(&token) {
            aliases.push(token);
        }
    }
    (aliases, ids)
}

/// 扫描本工作区最近的 Claude Code 会话记录，收集实际用过的模型 id（新→旧）
fn claude_models_from_sessions(cwd: &str) -> Vec<String> {
    use std::io::BufRead;
    let Some(dir) = claude_project_dir(cwd) else {
        return vec![];
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((mtime, path))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));

    let mut seen: Vec<String> = Vec::new();
    for (_, path) in files.into_iter().take(5) {
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        for line in std::io::BufReader::new(file).lines() {
            let Ok(line) = line else { break };
            let Some(pos) = line.find("\"model\":\"claude-") else {
                continue;
            };
            let tail = &line[pos + 9..];
            let Some(end) = tail.find('"') else { continue };
            let id = tail[..end].to_string();
            if !seen.contains(&id) {
                seen.push(id);
            }
        }
    }
    seen.truncate(6);
    seen
}

/// 引擎可选模型列表，全部动态获取：
/// - claude：别名来自 `claude --help`，完整 id 来自本机会话里实际用过的模型
/// - codex：`codex debug models` 实时目录
/// 拉不到时才退回写死的兜底。
#[tauri::command]
pub async fn list_models(engine: String, cwd: Option<String>) -> Vec<ModelOption> {
    if engine == "codex" {
        if let Some(bin) = resolve_codex_bin() {
            let mut cmd = tokio::process::Command::new(&bin);
            cmd.args(["debug", "models"])
                .env("HTTP_PROXY", DEFAULT_PROXY)
                .env("HTTPS_PROXY", DEFAULT_PROXY)
                .env("ALL_PROXY", DEFAULT_PROXY)
                .env("NO_PROXY", "localhost,127.0.0.1")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Ok(Ok(out)) =
                tokio::time::timeout(std::time::Duration::from_secs(8), cmd.output()).await
            {
                if out.status.success() {
                    if let Some(list) = parse_codex_models(&out.stdout) {
                        return list;
                    }
                }
            }
        }
        return vec![
            model("default", "默认"),
            model("gpt-5.6-sol", "GPT-5.6-Sol"),
            model("gpt-5.6-terra", "GPT-5.6-Terra"),
            model("gpt-5.6-luna", "GPT-5.6-Luna"),
            model("gpt-5.5", "GPT-5.5"),
            model("gpt-5.4", "GPT-5.4"),
            model("gpt-5.4-mini", "GPT-5.4-Mini"),
        ];
    }

    let mut out = vec![model("default", "默认")];

    let (mut aliases, help_ids) = match resolve_claude_bin() {
        Some(bin) => claude_models_from_help(&bin).await,
        None => (vec![], vec![]),
    };
    if aliases.is_empty() {
        aliases = vec!["fable".into(), "opus".into(), "sonnet".into(), "haiku".into()];
    }
    for alias in &aliases {
        let mut label: String = alias.clone();
        if let Some(first) = label.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        out.push(model(alias, &format!("{label}（最新）")));
    }

    // 本机会话实际用过的模型 + 帮助文本里的示例 id
    let mut ids = cwd
        .as_deref()
        .map(claude_models_from_sessions)
        .unwrap_or_default();
    for id in help_ids {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        ids = vec![
            "claude-fable-5".into(),
            "claude-opus-4-8".into(),
            "claude-sonnet-5".into(),
            "claude-haiku-4-5".into(),
        ];
    }
    for id in ids {
        if !out.iter().any(|m| m.id == id) {
            let label = id.clone();
            out.push(model(&id, &label));
        }
    }

    out
}

/// 历史会话列表项
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionInfo {
    pub session_id: String,
    pub title: String,
    /// 毫秒时间戳（文件 mtime）
    pub updated_at: u64,
    /// "claude" | "codex"
    pub engine: String,
}

/// 历史消息（结构与前端 ChatMessage 对齐）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
    pub thinking: String,
    pub tools: Vec<HistoryTool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

/// Claude Code 会话目录：~/.claude/projects/{编码后的 cwd}
/// 编码规则：非字母数字的字符全部替换为 '-'
fn claude_project_dir(cwd: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let encoded: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(PathBuf::from(home).join(".claude").join("projects").join(encoded))
}

/// 用户消息里的正文（跳过 meta/命令行噪音）
fn user_text_from_content(content: &serde_json::Value) -> Option<String> {
    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        arr.iter()
            .find(|b| b.get("type").and_then(|v| v.as_str()) == Some("text"))
            .and_then(|b| b.get("text").and_then(|v| v.as_str()))
            .map(String::from)?
    } else {
        return None;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.starts_with("Caveat:") {
        return None;
    }
    Some(trimmed.to_string())
}

/// 提取会话标题：custom-title > ai-title > 第一条用户消息
fn session_title(path: &std::path::Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut custom: Option<String> = None;
    let mut ai: Option<String> = None;
    let mut first_user: Option<String> = None;

    for line in reader.lines() {
        let Ok(line) = line else { break };
        // 大文件逐行全量解析太慢，先做廉价子串预筛
        let has_custom = line.contains("\"type\":\"custom-title\"");
        let has_ai = line.contains("\"type\":\"ai-title\"");
        let need_user = first_user.is_none() && line.contains("\"type\":\"user\"");
        if !has_custom && !has_ai && !need_user {
            continue;
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match json.get("type").and_then(|v| v.as_str()) {
            Some("custom-title") => {
                custom = json
                    .get("customTitle")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
            Some("ai-title") => {
                ai = json.get("aiTitle").and_then(|v| v.as_str()).map(String::from);
            }
            Some("user") if first_user.is_none() => {
                if json.get("isSidechain").and_then(|v| v.as_bool()) == Some(true)
                    || json.get("isMeta").and_then(|v| v.as_bool()) == Some(true)
                {
                    continue;
                }
                if let Some(content) = json.pointer("/message/content") {
                    first_user = user_text_from_content(content);
                }
            }
            _ => {}
        }
    }

    custom
        .or(ai)
        .or(first_user)
        .map(|t| t.chars().take(40).collect())
}

/// ~/.codex/sessions（rollout 按 YYYY/MM/DD 分层）
fn codex_sessions_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".codex").join("sessions"))
}

fn collect_codex_rollouts(dir: &std::path::Path, out: &mut Vec<(std::time::SystemTime, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_codex_rollouts(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            if let Ok(meta) = entry.metadata() {
                if let Ok(mtime) = meta.modified() {
                    out.push((mtime, path));
                }
            }
        }
    }
}

/// codex 记录里的用户正文（跳过 <environment_context>、# AGENTS.md 等注入噪音）
fn codex_user_text(payload: &serde_json::Value) -> Option<String> {
    let content = payload.get("content")?.as_array()?;
    for item in content {
        let typ = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if typ != "input_text" && typ != "text" {
            continue;
        }
        let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
        if text.is_empty() || text.starts_with('<') || text.starts_with('#') {
            continue;
        }
        return Some(text.to_string());
    }
    None
}

/// 列出 Codex 历史会话：扫 rollout 文件，首行 session_meta 按 cwd 过滤
fn list_codex_sessions(cwd: &str) -> Vec<ChatSessionInfo> {
    use std::io::BufRead;
    let Some(dir) = codex_sessions_dir() else {
        return vec![];
    };
    let mut files = Vec::new();
    collect_codex_rollouts(&dir, &mut files);
    files.sort_by(|a, b| b.0.cmp(&a.0));

    let mut sessions = Vec::new();
    for (mtime, path) in files.into_iter().take(100) {
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut lines = std::io::BufReader::new(file).lines();

        // 首行必须是本工作区的 session_meta
        let Some(Ok(first)) = lines.next() else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&first) else {
            continue;
        };
        if meta.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
            continue;
        }
        let Some(payload) = meta.get("payload") else {
            continue;
        };
        if payload.get("cwd").and_then(|v| v.as_str()) != Some(cwd) {
            continue;
        }
        let Some(id) = payload.get("id").and_then(|v| v.as_str()) else {
            continue;
        };

        // 标题：第一条真实用户消息；没有的（预热/纯系统）不展示
        let mut title: Option<String> = None;
        for line in lines {
            let Ok(line) = line else { break };
            if !line.contains("\"role\":\"user\"") {
                continue;
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(p) = json.get("payload") else { continue };
            if p.get("type").and_then(|v| v.as_str()) != Some("message") {
                continue;
            }
            if let Some(text) = codex_user_text(p) {
                title = Some(text.chars().take(40).collect());
                break;
            }
        }
        let Some(title) = title else { continue };

        let updated_at = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        sessions.push(ChatSessionInfo {
            session_id: id.to_string(),
            title,
            updated_at,
            engine: "codex".into(),
        });
    }
    sessions
}

/// 读取 Codex 会话完整记录（按文件名里的会话 id 定位 rollout）
fn load_codex_history(session_id: &str) -> Result<Vec<HistoryMessage>, String> {
    use std::io::BufRead;
    let dir = codex_sessions_dir().ok_or("无法定位 Codex 会话目录")?;
    let mut files = Vec::new();
    collect_codex_rollouts(&dir, &mut files);
    let suffix = format!("{session_id}.jsonl");
    let path = files
        .into_iter()
        .map(|(_, p)| p)
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with(&suffix))
                .unwrap_or(false)
        })
        .ok_or("找不到该会话的记录文件")?;

    let file = std::fs::File::open(&path).map_err(|e| format!("读取会话文件失败：{e}"))?;
    let mut messages: Vec<HistoryMessage> = Vec::new();

    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if json.get("type").and_then(|v| v.as_str()) != Some("response_item") {
            continue;
        }
        let Some(p) = json.get("payload") else { continue };

        match p.get("type").and_then(|v| v.as_str()) {
            Some("message") => match p.get("role").and_then(|v| v.as_str()) {
                Some("user") => {
                    if let Some(text) = codex_user_text(p) {
                        messages.push(HistoryMessage {
                            role: "user".into(),
                            content: text,
                            thinking: String::new(),
                            tools: Vec::new(),
                        });
                    }
                }
                Some("assistant") => {
                    let text: String = p
                        .get("content")
                        .and_then(|c| c.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|i| i.get("text").and_then(|v| v.as_str()))
                                .collect::<Vec<_>>()
                                .join("\n\n")
                        })
                        .unwrap_or_default();
                    if text.is_empty() {
                        continue;
                    }
                    if messages.last().map(|m| m.role.as_str()) == Some("assistant") {
                        let last = messages.last_mut().unwrap();
                        if !last.content.is_empty() {
                            last.content.push_str("\n\n");
                        }
                        last.content.push_str(&text);
                    } else {
                        messages.push(HistoryMessage {
                            role: "assistant".into(),
                            content: text,
                            thinking: String::new(),
                            tools: Vec::new(),
                        });
                    }
                }
                _ => {}
            },
            // 推理摘要 → 思考过程
            Some("reasoning") => {
                let mut chunks = Vec::new();
                for key in ["summary", "content"] {
                    if let Some(arr) = p.get(key).and_then(|v| v.as_array()) {
                        for item in arr {
                            if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                                if !t.is_empty() {
                                    chunks.push(t.to_string());
                                }
                            }
                        }
                    }
                }
                if chunks.is_empty() {
                    continue;
                }
                if messages.last().map(|m| m.role.as_str()) != Some("assistant") {
                    messages.push(HistoryMessage {
                        role: "assistant".into(),
                        content: String::new(),
                        thinking: String::new(),
                        tools: Vec::new(),
                    });
                }
                let last = messages.last_mut().unwrap();
                last.thinking.push_str(&chunks.join("\n"));
            }
            // 工具调用：exec_command 显示命令，其余显示工具名
            Some("function_call") => {
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                let label = p
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .and_then(|args| serde_json::from_str::<serde_json::Value>(args).ok())
                    .and_then(|args| {
                        for key in ["cmd", "command", "path", "file_path", "query"] {
                            if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                                return Some(format!(
                                    "$ {}",
                                    v.chars().take(48).collect::<String>()
                                ));
                            }
                        }
                        None
                    })
                    .unwrap_or_else(|| name.to_string());
                if messages.last().map(|m| m.role.as_str()) != Some("assistant") {
                    messages.push(HistoryMessage {
                        role: "assistant".into(),
                        content: String::new(),
                        thinking: String::new(),
                        tools: Vec::new(),
                    });
                }
                messages
                    .last_mut()
                    .unwrap()
                    .tools
                    .push(HistoryTool { name: label, result: None });
            }
            Some("function_call_output") => {
                if let Some(last) = messages.last_mut().filter(|m| m.role == "assistant") {
                    if let Some(tool) = last.tools.iter_mut().find(|t| t.result.is_none()) {
                        let summary = p
                            .get("output")
                            .map(|o| match o.as_str() {
                                Some(s) => s.chars().take(120).collect(),
                                None => tool_input_summary(o),
                            })
                            .unwrap_or_else(|| "完成".into());
                        tool.result = Some(summary);
                    }
                }
            }
            _ => {}
        }
    }

    Ok(messages)
}

/// 列出当前工作区的 Claude Code 会话
fn list_claude_sessions(cwd: &str) -> Vec<ChatSessionInfo> {
    let Some(dir) = claude_project_dir(cwd) else {
        return vec![];
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![];
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(String::from)
        else {
            continue;
        };
        // 没有标题也没有用户消息的会话（预热等）不展示
        let Some(title) = session_title(&path) else {
            continue;
        };
        let updated_at = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        sessions.push(ChatSessionInfo {
            session_id,
            title,
            updated_at,
            engine: "claude".into(),
        });
    }
    sessions
}

/// Claude 与 Codex 的会话合并成一个列表（按更新时间倒序）
#[tauri::command]
pub fn list_chat_sessions(cwd: String) -> Vec<ChatSessionInfo> {
    let mut sessions = list_claude_sessions(&cwd);
    sessions.extend(list_codex_sessions(&cwd));
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

/// 读取某个会话的完整消息记录，供前端恢复历史对话。engine 选 "claude"（默认）或 "codex"。
#[tauri::command]
pub fn load_chat_history(
    cwd: String,
    session_id: String,
    engine: Option<String>,
) -> Result<Vec<HistoryMessage>, String> {
    use std::io::BufRead;
    if engine.as_deref() == Some("codex") {
        return load_codex_history(&session_id);
    }
    let dir = claude_project_dir(&cwd).ok_or("无法定位 Claude Code 会话目录")?;
    let path = dir.join(format!("{session_id}.jsonl"));
    let file = std::fs::File::open(&path).map_err(|e| format!("读取会话文件失败：{e}"))?;
    let reader = std::io::BufReader::new(file);

    let mut messages: Vec<HistoryMessage> = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if json.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }

        match json.get("type").and_then(|v| v.as_str()) {
            Some("user") => {
                if json.get("isMeta").and_then(|v| v.as_bool()) == Some(true) {
                    continue;
                }
                let Some(content) = json.pointer("/message/content") else {
                    continue;
                };
                // 工具结果回写：标记到最后一条 assistant 消息的未完成工具上
                if let Some(arr) = content.as_array() {
                    for item in arr {
                        if item.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                            if let Some(last) =
                                messages.last_mut().filter(|m| m.role == "assistant")
                            {
                                if let Some(tool) =
                                    last.tools.iter_mut().find(|t| t.result.is_none())
                                {
                                    let summary = item
                                        .get("content")
                                        .map(tool_input_summary)
                                        .unwrap_or_else(|| "完成".into());
                                    tool.result = Some(summary);
                                }
                            }
                        }
                    }
                }
                if let Some(text) = user_text_from_content(content) {
                    messages.push(HistoryMessage {
                        role: "user".into(),
                        content: text,
                        thinking: String::new(),
                        tools: Vec::new(),
                    });
                }
            }
            Some("assistant") => {
                let Some(blocks) = json.pointer("/message/content").and_then(|c| c.as_array())
                else {
                    continue;
                };
                // 同一轮回复会拆成多条 assistant 记录，连续的合并成一条
                if messages.last().map(|m| m.role.as_str()) != Some("assistant") {
                    messages.push(HistoryMessage {
                        role: "assistant".into(),
                        content: String::new(),
                        thinking: String::new(),
                        tools: Vec::new(),
                    });
                }
                let last = messages.last_mut().unwrap();
                for block in blocks {
                    match block.get("type").and_then(|v| v.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                if !last.content.is_empty() {
                                    last.content.push_str("\n\n");
                                }
                                last.content.push_str(t);
                            }
                        }
                        Some("thinking") => {
                            if let Some(t) = block.get("thinking").and_then(|v| v.as_str()) {
                                last.thinking.push_str(t);
                            }
                        }
                        Some("tool_use") => {
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            last.tools.push(HistoryTool { name, result: None });
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    Ok(messages)
}

/// 流式事件，emit 给前端（事件名 "chat-stream"）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamEvent {
    /// text | thinking | tool_use | tool_result | status | done | error
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ChatStreamEvent {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            delta: None,
            tool_name: None,
            tool_input: None,
            session_id: None,
            error: None,
        }
    }
}

/// 从工具输入里抽一个简短摘要（文件路径 / 命令 / 查询词等）
fn tool_input_summary(input: &serde_json::Value) -> String {
    for key in ["file_path", "path", "pattern", "command", "query", "url", "prompt"] {
        if let Some(v) = input.get(key).and_then(|v| v.as_str()) {
            return v.chars().take(120).collect();
        }
    }
    let s = input.to_string();
    s.chars().take(120).collect()
}

/// 发送一条消息，流式跑一轮对话。engine 选 "claude"（默认）或 "codex"。
/// 通过事件 "chat-stream" 把增量推给前端，结束 emit done（带 session_id 供下一轮 resume）。
#[tauri::command]
pub async fn send_chat_message(
    app: AppHandle,
    message: String,
    resume_id: Option<String>,
    cwd: Option<String>,
    engine: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let model = model.filter(|m| !m.is_empty() && m != "default");
    match engine.as_deref() {
        Some("codex") => send_codex_message(app, message, resume_id, cwd, model).await,
        _ => send_claude_message(app, message, resume_id, cwd, model).await,
    }
}

/// Claude Code 路径：resume_id 为空走新会话（--session-id），否则 --resume。
async fn send_claude_message(
    app: AppHandle,
    message: String,
    resume_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let bin = resolve_claude_bin().ok_or_else(|| "未找到 claude 可执行文件".to_string())?;

    let new_session = uuid::Uuid::new_v4().to_string();

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--allowedTools")
        .arg("WebSearch,WebFetch,Read,Glob,Grep");

    if let Some(m) = &model {
        cmd.arg("--model").arg(m);
    }

    match &resume_id {
        Some(id) if !id.is_empty() => {
            cmd.arg("--resume").arg(id);
        }
        _ => {
            cmd.arg("--session-id").arg(&new_session);
        }
    }

    // 工作目录：默认用户工作区根（让 AI 能看到练习项目），可由前端覆盖
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }

    // 代理：默认 7890，让 claude 能联网
    cmd.env("HTTP_PROXY", DEFAULT_PROXY)
        .env("HTTPS_PROXY", DEFAULT_PROXY)
        .env("ALL_PROXY", DEFAULT_PROXY)
        .env("NO_PROXY", "localhost,127.0.0.1");

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 claude：{e}"))?;

    // 写 prompt 到 stdin 后关闭写端
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(message.as_bytes())
            .await
            .map_err(|e| format!("写入消息失败：{e}"))?;
        drop(stdin);
    }

    let stdout = child.stdout.take().ok_or("无法获取 claude 输出")?;
    let mut reader = BufReader::new(stdout).lines();

    let mut session_id: Option<String> = None;

    while let Ok(Some(line)) = reader.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let typ = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match typ {
            // 初始化：拿 session_id
            "system" => {
                if json.get("subtype").and_then(|v| v.as_str()) == Some("init") {
                    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                        session_id = Some(sid.to_string());
                        let mut ev = ChatStreamEvent::new("status");
                        ev.session_id = Some(sid.to_string());
                        let _ = app.emit("chat-stream", &ev);
                    }
                }
            }
            // 流式增量：文本 / 思考
            "stream_event" => {
                if let Some(event) = json.get("event") {
                    let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if etype == "content_block_delta" {
                        if let Some(delta) = event.get("delta") {
                            let dtype = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if dtype == "text_delta" {
                                if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                                    let mut ev = ChatStreamEvent::new("text");
                                    ev.delta = Some(t.to_string());
                                    let _ = app.emit("chat-stream", &ev);
                                }
                            } else if dtype == "thinking_delta" {
                                if let Some(t) = delta.get("thinking").and_then(|v| v.as_str()) {
                                    let mut ev = ChatStreamEvent::new("thinking");
                                    ev.delta = Some(t.to_string());
                                    let _ = app.emit("chat-stream", &ev);
                                }
                            }
                        }
                    } else if etype == "content_block_start" {
                        // 工具调用开始
                        if let Some(block) = event.get("content_block") {
                            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                                let name = block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("tool")
                                    .to_string();
                                let mut ev = ChatStreamEvent::new("tool_use");
                                ev.tool_name = Some(name);
                                let _ = app.emit("chat-stream", &ev);
                            }
                        }
                    }
                }
            }
            // 工具结果（user 消息里回写）
            "user" => {
                if let Some(content) = json
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for item in content {
                        if item.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                            let summary = item
                                .get("content")
                                .map(|c| tool_input_summary(c))
                                .unwrap_or_default();
                            let mut ev = ChatStreamEvent::new("tool_result");
                            ev.tool_input = Some(summary);
                            let _ = app.emit("chat-stream", &ev);
                        }
                    }
                }
            }
            // 本轮结束
            "result" => {
                let subtype = json.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                if subtype != "success" {
                    let msg = json
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("对话出错")
                        .to_string();
                    let mut ev = ChatStreamEvent::new("error");
                    ev.error = Some(msg);
                    let _ = app.emit("chat-stream", &ev);
                }
            }
            _ => {}
        }
    }

    // 读 stderr（出错时给前端看）
    if let Some(stderr) = child.stderr.take() {
        let mut err_text = String::new();
        let mut err_reader = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = err_reader.next_line().await {
            err_text.push_str(&l);
            err_text.push('\n');
        }
        let _ = err_text; // 暂不强制上报，result 已覆盖主要错误
    }

    let _ = child.wait().await;

    // 结束信号，带上 session_id 供下一轮 resume
    let mut done = ChatStreamEvent::new("done");
    done.session_id = session_id.or(Some(new_session));
    let _ = app.emit("chat-stream", &done);

    Ok(())
}

/// Codex 路径：`codex exec --json`（JSONL 事件流），多轮用 `codex exec resume <thread_id>`。
/// 事件模型参考 Open Design 的 handleCodexEvent：thread.started / item.* / turn.*。
async fn send_codex_message(
    app: AppHandle,
    message: String,
    resume_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let bin = resolve_codex_bin().ok_or_else(|| "未找到 codex 可执行文件".to_string())?;

    let mut cmd = tokio::process::Command::new(&bin);
    match &resume_id {
        Some(id) if !id.is_empty() => {
            cmd.arg("exec").arg("resume").arg(id);
        }
        _ => {
            cmd.arg("exec");
        }
    }
    // 沙箱允许工作区写 + 联网。注意 `exec resume` 不支持 --sandbox flag，
    // 统一用 -c 配置覆盖（两条路径都接受）。
    cmd.arg("--json")
        .arg("--skip-git-repo-check")
        .arg("-c")
        .arg("sandbox_mode=\"workspace-write\"")
        .arg("-c")
        .arg("sandbox_workspace_write.network_access=true");

    if let Some(m) = &model {
        cmd.arg("--model").arg(m);
    }

    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }

    cmd.env("HTTP_PROXY", DEFAULT_PROXY)
        .env("HTTPS_PROXY", DEFAULT_PROXY)
        .env("ALL_PROXY", DEFAULT_PROXY)
        .env("NO_PROXY", "localhost,127.0.0.1");

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("无法启动 codex：{e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(message.as_bytes())
            .await
            .map_err(|e| format!("写入消息失败：{e}"))?;
        drop(stdin);
    }

    let stdout = child.stdout.take().ok_or("无法获取 codex 输出")?;
    let mut reader = BufReader::new(stdout).lines();

    let mut session_id: Option<String> = None;
    let mut error_emitted = false;

    while let Ok(Some(line)) = reader.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let typ = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match typ {
            "thread.started" => {
                if let Some(tid) = json.get("thread_id").and_then(|v| v.as_str()) {
                    session_id = Some(tid.to_string());
                    let mut ev = ChatStreamEvent::new("status");
                    ev.session_id = Some(tid.to_string());
                    let _ = app.emit("chat-stream", &ev);
                }
            }
            "item.started" | "item.completed" => {
                let Some(item) = json.get("item") else { continue };
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match item_type {
                    // 命令执行：started 发 tool_use，completed 发 tool_result
                    "command_execution" => {
                        if typ == "item.started" {
                            let command = item
                                .get("command")
                                .and_then(|v| v.as_str())
                                .unwrap_or("shell");
                            let mut ev = ChatStreamEvent::new("tool_use");
                            ev.tool_name =
                                Some(format!("$ {}", command.chars().take(48).collect::<String>()));
                            let _ = app.emit("chat-stream", &ev);
                        } else {
                            let output = item
                                .get("aggregated_output")
                                .and_then(|v| v.as_str())
                                .unwrap_or("完成");
                            let mut ev = ChatStreamEvent::new("tool_result");
                            ev.tool_input = Some(output.chars().take(120).collect());
                            let _ = app.emit("chat-stream", &ev);
                        }
                    }
                    // 最终回复文本（整段到达，不是增量）
                    "agent_message" if typ == "item.completed" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                let mut ev = ChatStreamEvent::new("text");
                                ev.delta = Some(text.to_string());
                                let _ = app.emit("chat-stream", &ev);
                            }
                        }
                    }
                    // 推理摘要 → 思考过程
                    "reasoning" if typ == "item.completed" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                let mut ev = ChatStreamEvent::new("thinking");
                                ev.delta = Some(text.to_string());
                                let _ = app.emit("chat-stream", &ev);
                            }
                        }
                    }
                    _ => {}
                }
            }
            "turn.failed" | "error" => {
                if !error_emitted {
                    error_emitted = true;
                    let msg = json
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str())
                        .or_else(|| json.get("message").and_then(|v| v.as_str()))
                        .unwrap_or("Codex 出错")
                        .to_string();
                    let mut ev = ChatStreamEvent::new("error");
                    ev.error = Some(msg);
                    let _ = app.emit("chat-stream", &ev);
                }
            }
            _ => {}
        }
    }

    // 收集 stderr，进程失败且没报过错时兜底上报（比如未登录）
    let mut err_text = String::new();
    if let Some(stderr) = child.stderr.take() {
        let mut err_reader = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = err_reader.next_line().await {
            err_text.push_str(&l);
            err_text.push('\n');
        }
    }

    let status = child.wait().await;
    let failed = !matches!(&status, Ok(s) if s.success());
    if failed && !error_emitted {
        // clap 的 "error: ..." 在最前面，取头部几行
        let head: String = err_text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(5)
            .collect::<Vec<_>>()
            .join("\n");
        let mut ev = ChatStreamEvent::new("error");
        ev.error = Some(if head.is_empty() {
            "codex 进程异常退出".into()
        } else {
            head
        });
        let _ = app.emit("chat-stream", &ev);
    }

    let mut done = ChatStreamEvent::new("done");
    done.session_id = session_id.or(resume_id);
    let _ = app.emit("chat-stream", &done);

    Ok(())
}
