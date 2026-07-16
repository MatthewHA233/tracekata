// ══════════════════════════════════════════════
// 锚点域后端 — 工作区级 JSON 存储 + 语境锚定 + 增量嵌入 + 簇命名
//
// 架构参考 solo-leveling-system 的锚点域：
//   · 锚点句 = 从「你对代码语境说的原话」提取的完整句（10~30 字），归三类
//   · 绑定 = 语境片段 + 原话 + 想法卡 + 锚点引用（多对多）
//   · 向量 = DashScope 兼容 /embeddings，256 维，增量嵌入只花一次钱
//   · 提取/簇命名可走 API（默认直连，不走 7890）或本机 Claude/Codex CLI（走 7890）
// ══════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

// ── 数据模型 ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub id: String,
    pub keyword: String,
    /// motive | view | practice
    pub category: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorBinding {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub exercise_id: String,
    /// 语境来源标识，如 "014 提取启用命令 · 题目索引.md"
    pub context_label: String,
    /// 从语境逐字复制的片段（前端 indexOf 尽力高亮；文件会被手敲改动，不存位置）
    pub segment: String,
    pub user_speech: String,
    pub thought: String,
    pub anchor_ids: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorFieldData {
    pub anchors: Vec<Anchor>,
    pub bindings: Vec<AnchorBinding>,
    pub embeddings: HashMap<String, Vec<f32>>,
    pub cluster_names: HashMap<String, String>,
}

/// 前端每次调用传入的服务配置（不在后端落盘）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorService {
    #[serde(default)]
    pub api_base: String,
    #[serde(default)]
    pub api_key: String,
    /// api | claude | codex
    #[serde(default)]
    pub extract_via: String,
    #[serde(default)]
    pub extract_model: String,
    #[serde(default)]
    pub embed_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedAnchor {
    pub keyword: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResult {
    pub worth: bool,
    pub segment: String,
    pub thought: String,
    pub anchors: Vec<ExtractedAnchor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRecordResult {
    pub binding: AnchorBinding,
    pub anchors: Vec<Anchor>,
}

// ── 存储 ──────────────────────────────────────

fn field_dir() -> Result<PathBuf, String> {
    let root = crate::find_workspace_root()?;
    Ok(root.join(".tracekata").join("anchor-field"))
}

fn load_json<T: serde::de::DeserializeOwned + Default>(path: &PathBuf) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn now_iso() -> String {
    // 本地时区的 ISO 秒级时间戳（与前端展示一致即可）
    let out = std::process::Command::new("date")
        .arg("+%Y-%m-%dT%H:%M:%S")
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

fn short_id() -> String {
    uuid::Uuid::new_v4().to_string()[..8].to_string()
}

// ── prompt（三类判定规则与参考项目保持语义一致，示例改为代码学习场景）──

const ANCHOR_TAXONOMY: &str = r#"锚点按主人说话的「姿态」分三类（不按名词类型）：
- motive（刺激·动机）：被内容击中、冒出"我想去做某事"的冲动
- view（观点·看法）：下了判断、表达了立场或认识
- practice（教程·实践）：沉淀出可操作的方法、步骤、技巧经验

提取规则：
1. 先判断这番话命中哪几类（通常只有一类，最多两类），再为每个命中的类写一条「锚点句」
2. 锚点句是一句完整的话（10~30 字），单独拿出来也能读懂主人的冲动/判断/做法；不是压缩关键词，更不是光秃名词
3. 锚点句不带触发条件/来源（"写完这题""看完示范代码后"这类前缀一律去掉）。锚点要跨语境共享——同一个认识可能在很多道题里反复出现，触发它的语境已由绑定单独记录；锚点句只写姿态本身：想做什么 / 怎么判断 / 怎么做。
4. 示例（代码学习场景）：
   - "写完这题我都想把项目里的重复分支抽成命令注册表了"
     → [{"keyword":"想把项目里的重复分支重构成命令注册表","category":"motive"}]
   - "回调地狱本质上是控制流被拆散了"
     → [{"keyword":"回调地狱本质是控制流被拆散","category":"view"}]
   - "filter 的谓词返回 true 才保留该项，别在里面改原数组"
     → [{"keyword":"filter 谓词返回 true 保留该项且不改原数组","category":"practice"}]"#;

fn extract_system_prompt() -> String {
    format!(
        r#"你是「语境锚定器」。主人正在看一段代码语境（题目说明 / 示范代码 / 自己手敲的代码），并对你说了一句话。

你的任务，严格按顺序：
0. 先判断这句话值不值得记录：必须是主人对语境的真实想法/反应（亲身经验、观点、动机、收获）。若只是提问、查询、给你的指令、测试、闲聊寒暄、对本软件界面的评论——直接输出 {{"worth":false}}，跳过后面所有步骤。宁可漏掉，绝不误记。
1. 从【语境原文】里逐字复制出与主人想法最相关的一段原文（1~3 行、连续片段，必须和原文一字不差，用于定位高亮）
2. 把主人的想法整理成想法卡正文：贴近主人原话表述，只去口语啰嗦、轻微润色通顺，不总结、不改写核心、不加你的评论
3. 从主人的想法里提取锚点。{ANCHOR_TAXONOMY}

只输出 JSON，无任何额外文字或代码块标记：
- 值得：{{"worth":true,"segment":"<从语境逐字复制的原文片段>","thought":"<想法卡正文>","anchors":[{{"keyword":"..","category":".."}}]}}
- 不值得：{{"worth":false}}

若想法值得记但和语境对不上具体段落，segment 留空字符串。"#
    )
}

const NAME_SYSTEM_PROMPT: &str = r#"你是「区域命名者」。给一组同主题的句子起一个简洁的关键词式名字（2~8 字），像地图上的地名。
要求：直接用这组句子共同指向的核心关键词（参考风格："数组方法""命令注册表""异步控制流"），宁可具体，不要抽象拔高，也不要整句照抄。
只输出名字本身，不要引号、标点、解释。"#;

// ── LLM 调用（api / claude / codex 三路分流）────

async fn run_llm(
    settings: &AnchorService,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    match settings.extract_via.as_str() {
        "claude" => run_claude_oneshot(&format!("{system}\n\n{user}")).await,
        "codex" => run_codex_oneshot(&format!("{system}\n\n{user}")).await,
        _ => run_chat_api(settings, system, user, max_tokens).await,
    }
}

/// DashScope 兼容 /chat/completions（显式 no_proxy 直连）
async fn run_chat_api(
    settings: &AnchorService,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    if settings.api_key.is_empty() {
        return Err("未配置 API Key".into());
    }
    if settings.extract_model.is_empty() {
        return Err("未配置提取模型".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!(
        "{}/chat/completions",
        settings.api_base.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "model": settings.extract_model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "max_tokens": max_tokens,
    });
    let resp = client
        .post(&url)
        .bearer_auth(&settings.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = json
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("API 调用失败");
        return Err(format!("HTTP {status}：{msg}"));
    }
    json.pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "API 返回缺少内容".into())
}

/// 一次性 headless 调 claude -p（走 7890 代理，与聊天路径一致）
async fn run_claude_oneshot(prompt: &str) -> Result<String, String> {
    let bin = crate::claude::resolve_claude_bin().ok_or("未找到 claude 可执行文件")?;
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("-p")
        .env("HTTP_PROXY", crate::claude::DEFAULT_PROXY)
        .env("HTTPS_PROXY", crate::claude::DEFAULT_PROXY)
        .env("ALL_PROXY", crate::claude::DEFAULT_PROXY)
        .env("NO_PROXY", "localhost,127.0.0.1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 claude：{e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        drop(stdin);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(90), child.wait_with_output())
        .await
        .map_err(|_| "claude 提取超时（90 秒）".to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "claude 提取失败：{}",
            err.lines().next().unwrap_or("未知错误")
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 一次性 headless 调 codex exec（只读沙箱，走 7890 代理）
async fn run_codex_oneshot(prompt: &str) -> Result<String, String> {
    let bin = crate::claude::resolve_codex_bin().ok_or("未找到 codex 可执行文件")?;
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("exec")
        .arg("--json")
        .arg("--skip-git-repo-check")
        .arg("-c")
        .arg("sandbox_mode=\"read-only\"")
        .env("HTTP_PROXY", crate::claude::DEFAULT_PROXY)
        .env("HTTPS_PROXY", crate::claude::DEFAULT_PROXY)
        .env("ALL_PROXY", crate::claude::DEFAULT_PROXY)
        .env("NO_PROXY", "localhost,127.0.0.1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 codex：{e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        drop(stdin);
    }

    let stdout = child.stdout.take().ok_or("无法获取 codex 输出")?;
    let mut reader = BufReader::new(stdout).lines();
    let mut text = String::new();
    let read_all = async {
        while let Ok(Some(line)) = reader.next_line().await {
            let Ok(json) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue;
            };
            if json.get("type").and_then(|v| v.as_str()) == Some("item.completed") {
                if let Some(item) = json.get("item") {
                    if item.get("type").and_then(|v| v.as_str()) == Some("agent_message") {
                        if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                            text.push_str(t);
                        }
                    }
                }
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(90), read_all)
        .await
        .map_err(|_| "codex 提取超时（90 秒）".to_string())?;
    let _ = child.wait().await;
    if text.trim().is_empty() {
        return Err("codex 没有返回内容".into());
    }
    Ok(text.trim().to_string())
}

/// 容错解析：抽出首个 JSON 对象，应用值得性闸门与三类校验
fn parse_extract_json(raw: &str) -> Result<ExtractResult, String> {
    let start = raw.find('{').ok_or("模型输出里没有 JSON")?;
    let end = raw.rfind('}').ok_or("模型输出里没有 JSON")?;
    let obj: serde_json::Value =
        serde_json::from_str(&raw[start..=end]).map_err(|_| "模型输出的 JSON 无法解析")?;

    // 值得性闸门：显式 false 才拒；漏字段但有实质 thought 就放行
    if obj.get("worth").and_then(|v| v.as_bool()) == Some(false) {
        return Ok(ExtractResult {
            worth: false,
            segment: String::new(),
            thought: String::new(),
            anchors: vec![],
        });
    }
    let thought = obj
        .get("thought")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if thought.is_empty() {
        return Err("模型没给出想法卡正文".into());
    }
    let segment = obj
        .get("segment")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let valid = ["motive", "view", "practice"];
    let anchors = obj
        .get("anchors")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| {
                    let keyword = x.get("keyword")?.as_str()?.trim().to_string();
                    let category = x.get("category")?.as_str()?.to_string();
                    if keyword.is_empty() || !valid.contains(&category.as_str()) {
                        return None;
                    }
                    Some(ExtractedAnchor { keyword, category })
                })
                .take(3)
                .collect()
        })
        .unwrap_or_default();
    Ok(ExtractResult {
        worth: true,
        segment,
        thought,
        anchors,
    })
}

// ── 命令 ──────────────────────────────────────

#[tauri::command]
pub fn load_anchor_field() -> Result<AnchorFieldData, String> {
    let dir = field_dir()?;
    Ok(AnchorFieldData {
        anchors: load_json(&dir.join("anchors.json")),
        bindings: load_json(&dir.join("bindings.json")),
        embeddings: load_json(&dir.join("embeddings.json")),
        cluster_names: load_json(&dir.join("cluster-names.json")),
    })
}

/// 语境锚定：语境 + 原话 → worth 闸门 → 片段/想法卡/锚点句
#[tauri::command]
pub async fn extract_anchor(
    settings: AnchorService,
    context_text: String,
    user_speech: String,
) -> Result<ExtractResult, String> {
    let speech = user_speech.trim();
    if speech.chars().count() < 6 {
        return Err("想法太短了，多说两句。".into());
    }
    // 语境可能很长，截到 ~6000 字
    let ctx: String = context_text.chars().take(6000).collect();
    let user = format!("【语境原文】\n{ctx}\n\n【主人的想法】\n{speech}");
    let raw = run_llm(&settings, &extract_system_prompt(), &user, 700).await?;
    parse_extract_json(&raw)
}

/// 保存记录：锚点按 (keyword, category) 去重复用 + 追加绑定
#[tauri::command]
pub fn save_anchor_record(
    project_id: String,
    exercise_id: String,
    context_label: String,
    segment: String,
    user_speech: String,
    thought: String,
    anchors: Vec<ExtractedAnchor>,
) -> Result<SaveRecordResult, String> {
    let dir = field_dir()?;
    let anchors_path = dir.join("anchors.json");
    let bindings_path = dir.join("bindings.json");

    let mut all_anchors: Vec<Anchor> = load_json(&anchors_path);
    let mut bound: Vec<Anchor> = Vec::new();
    for ex in &anchors {
        let hit = all_anchors
            .iter()
            .find(|a| a.keyword == ex.keyword && a.category == ex.category)
            .cloned();
        let anchor = match hit {
            Some(a) => a,
            None => {
                let a = Anchor {
                    id: short_id(),
                    keyword: ex.keyword.clone(),
                    category: ex.category.clone(),
                    created_at: now_iso(),
                };
                all_anchors.push(a.clone());
                a
            }
        };
        bound.push(anchor);
    }
    save_json(&anchors_path, &all_anchors)?;

    let binding = AnchorBinding {
        id: short_id(),
        project_id,
        exercise_id,
        context_label,
        segment,
        user_speech,
        thought,
        anchor_ids: bound.iter().map(|a| a.id.clone()).collect(),
        created_at: now_iso(),
    };
    let mut bindings: Vec<AnchorBinding> = load_json(&bindings_path);
    bindings.push(binding.clone());
    save_json(&bindings_path, &bindings)?;

    Ok(SaveRecordResult {
        binding,
        anchors: bound,
    })
}

#[derive(Debug, Deserialize)]
struct EmbeddingsResponse {
    data: Option<Vec<EmbeddingItem>>,
    error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingItem {
    index: usize,
    embedding: Vec<f32>,
}

/// 增量嵌入：只对没有向量的锚点调 API 并回存。返回本次新嵌入的条数。
#[tauri::command]
pub async fn embed_missing_anchors(settings: AnchorService) -> Result<usize, String> {
    if settings.api_key.is_empty() {
        return Err("未配置 API Key，无法生成向量".into());
    }
    let dir = field_dir()?;
    let anchors: Vec<Anchor> = load_json(&dir.join("anchors.json"));
    let embeddings_path = dir.join("embeddings.json");
    let mut embeddings: HashMap<String, Vec<f32>> = load_json(&embeddings_path);

    let missing: Vec<&Anchor> = anchors
        .iter()
        .filter(|a| !embeddings.contains_key(&a.id))
        .collect();
    if missing.is_empty() {
        return Ok(0);
    }

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/embeddings", settings.api_base.trim_end_matches('/'));
    let model = if settings.embed_model.is_empty() {
        "text-embedding-v4"
    } else {
        &settings.embed_model
    };

    let mut done = 0usize;
    // text-embedding-v4 单次最多 10 条
    for batch in missing.chunks(10) {
        let body = serde_json::json!({
            "model": model,
            "input": batch.iter().map(|a| a.keyword.as_str()).collect::<Vec<_>>(),
            "dimensions": 256,
            "encoding_format": "float",
        });
        let result = async {
            let resp = client
                .post(&url)
                .bearer_auth(&settings.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("请求失败：{e}"))?;
            let status = resp.status();
            let json: EmbeddingsResponse = resp.json().await.map_err(|e| e.to_string())?;
            let Some(data) = json.data else {
                let msg = json
                    .error
                    .as_ref()
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("embeddings 返回异常");
                return Err(format!("HTTP {status}：{msg}"));
            };
            Ok(data)
        }
        .await;

        match result {
            Ok(data) => {
                for item in data {
                    if let Some(anchor) = batch.get(item.index) {
                        // 6 位小数够聚类用，减小文件体积
                        let rounded: Vec<f32> = item
                            .embedding
                            .iter()
                            .map(|x| (x * 1e6).round() / 1e6)
                            .collect();
                        embeddings.insert(anchor.id.clone(), rounded);
                        done += 1;
                    }
                }
                save_json(&embeddings_path, &embeddings)?;
            }
            Err(e) => {
                // 断网/限流：已嵌入的保留，剩下的下次打开地图自动补
                if done == 0 {
                    return Err(e);
                }
                break;
            }
        }
    }
    Ok(done)
}

/// AI 给簇起名（2~8 字）。失败返回 Err，前端回退首句且不缓存。
#[tauri::command]
pub async fn name_cluster(
    settings: AnchorService,
    keywords: Vec<String>,
) -> Result<String, String> {
    let user = format!(
        "这组锚点句：\n{}",
        keywords
            .iter()
            .map(|k| format!("- {k}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let raw = run_llm(&settings, NAME_SYSTEM_PROMPT, &user, 30).await?;
    let name: String = raw
        .chars()
        .filter(|c| !"\"'「」『』#。，！？".contains(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if name.is_empty() || name.chars().count() > 12 {
        return Err("簇名不可用".into());
    }
    Ok(name)
}

#[tauri::command]
pub fn save_cluster_name(member_hash: String, name: String) -> Result<(), String> {
    let dir = field_dir()?;
    let path = dir.join("cluster-names.json");
    let mut names: HashMap<String, String> = load_json(&path);
    names.insert(member_hash, name);
    save_json(&path, &names)
}
