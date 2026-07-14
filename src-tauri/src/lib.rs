use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

mod claude;

// 每个练习项目目录下有一份 tracekata.json，App 扫描发现，互不掺合。

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressiveTrack {
    id: String,
    title: String,
    base_offset: usize,
    exercise_ids: Vec<String>,
    created_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct RunConfig {
    file: String,
    args: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Exercise {
    id: String,
    title: String,
    base_from: Option<String>,
    practice_files: Vec<String>,
    demo_files: Vec<String>,
    run: RunConfig,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct ProjectConfig {
    name: Option<String>,
    index_file: String,
    memos_file: String,
    pinned: bool,
    archived: bool,
    tracks: Vec<ProgressiveTrack>,
    exercises: Vec<Exercise>,
}

#[derive(Clone, Debug)]
struct Project {
    id: String,
    dir: PathBuf,
    config: ProjectConfig,
}

impl Project {
    fn display_name(&self) -> String {
        self.config
            .name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| self.id.clone())
    }

    fn index_file(&self) -> String {
        if self.config.index_file.trim().is_empty() {
            "题目索引.md".to_string()
        } else {
            self.config.index_file.clone()
        }
    }

    fn memos_file(&self) -> String {
        if self.config.memos_file.trim().is_empty() {
            ".tracekata/memos.md".to_string()
        } else {
            self.config.memos_file.clone()
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackListItem {
    id: String,
    title: String,
    created_at: Option<String>,
    exercise_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectListItem {
    id: String,
    display_name: String,
    pinned: bool,
    archived: bool,
    tracks: Vec<TrackListItem>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackSummary {
    id: String,
    title: String,
    base_offset: usize,
    exercise_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExerciseSummary {
    id: String,
    title: String,
    base_from: Option<String>,
    practice_files: Vec<String>,
    demo_files: Vec<String>,
    run_file: String,
    run_args: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExerciseListItem {
    id: String,
    title: String,
    finished: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileItem {
    name: String,
    relative_path: String,
    kind: String,
    exists: bool,
    is_empty: bool,
    line_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileGroup {
    kind: String,
    files: Vec<FileItem>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoEntry {
    title: String,
    body: String,
    time: String,
    tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSkill {
    name: String,
    description: String,
    source: String,
    path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardState {
    workspace_root: String,
    projects: Vec<ProjectListItem>,
    current_project_id: Option<String>,
    current_track: Option<TrackSummary>,
    track_exercises: Vec<ExerciseListItem>,
    current_exercise: Option<ExerciseSummary>,
    base_hint: String,
    file_groups: Vec<FileGroup>,
    memos: Vec<MemoEntry>,
    ai_skills: Vec<AiSkill>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    message: String,
    changed_files: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunResult {
    command: String,
    status: Option<i32>,
    stdout: String,
    stderr: String,
}

// 选中状态只活在调用参数里，不写盘。
struct Selection<'a> {
    project: &'a Project,
    track: Option<&'a ProgressiveTrack>,
    exercise: Option<&'a Exercise>,
}

#[tauri::command]
fn load_dashboard_state(
    project_id: Option<String>,
    track_id: Option<String>,
    exercise_id: Option<String>,
) -> Result<DashboardState, String> {
    build_dashboard_state(
        project_id.as_deref(),
        track_id.as_deref(),
        exercise_id.as_deref(),
    )
}

#[tauri::command]
fn prepare_exercise(
    project_id: Option<String>,
    track_id: Option<String>,
    exercise_id: Option<String>,
) -> Result<CommandResult, String> {
    let (_root, projects) = load_workspace()?;
    let selection = resolve_selection(
        &projects,
        project_id.as_deref(),
        track_id.as_deref(),
        exercise_id.as_deref(),
    )?;
    let Some(exercise) = selection.exercise else {
        return Ok(CommandResult {
            message: "还没有可准备的练习。".to_string(),
            changed_files: vec![],
        });
    };
    let project = selection.project;
    let base = get_base_exercise(&project.config, exercise);
    let mut changed_files = vec![];

    for (index, file) in exercise.practice_files.iter().enumerate() {
        let target_path = project.dir.join(file);
        if target_path.exists() {
            continue;
        }

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        let base_file = base.and_then(|base_exercise| {
            base_exercise
                .practice_files
                .get(index)
                .or_else(|| base_exercise.practice_files.first())
        });
        let base_content = base_file
            .and_then(|base_name| fs::read_to_string(project.dir.join(base_name)).ok())
            .unwrap_or_default();
        let header = format!(
            "// TraceKata {}\n// 基底：{}\n// 已存在的文件不会被覆盖。\n\n",
            exercise.title,
            base.map(|base_exercise| format!("{} {}", base_exercise.id, base_exercise.title))
                .unwrap_or_else(|| "空白起点".to_string())
        );

        fs::write(&target_path, format!("{header}{base_content}"))
            .map_err(|error| error.to_string())?;
        changed_files.push(file.clone());
    }

    let message = if changed_files.is_empty() {
        "练习文件已经存在，没有覆盖。".to_string()
    } else {
        format!("已创建 {} 个练习文件。", changed_files.len())
    };

    Ok(CommandResult {
        message,
        changed_files,
    })
}

#[tauri::command]
fn open_workspace_file(relative_path: String) -> Result<CommandResult, String> {
    let (root, _projects) = load_workspace()?;
    let file_path = root.join(&relative_path);

    if !file_path.exists() {
        return Err(format!("文件不存在：{relative_path}"));
    }

    open_with_vscode(&file_path)?;

    Ok(CommandResult {
        message: format!("已打开：{relative_path}"),
        changed_files: vec![],
    })
}

#[tauri::command]
fn open_exercise_scene(
    project_id: Option<String>,
    track_id: Option<String>,
    exercise_id: Option<String>,
) -> Result<CommandResult, String> {
    let state = build_dashboard_state(
        project_id.as_deref(),
        track_id.as_deref(),
        exercise_id.as_deref(),
    )?;
    let mut opened = 0;

    for group in state.file_groups {
        for file in group.files {
            let path = Path::new(&state.workspace_root).join(&file.relative_path);
            if path.exists() && open_with_vscode(&path).is_ok() {
                opened += 1;
            }
        }
    }

    Ok(CommandResult {
        message: format!("已请求 VSCode 打开 {} 个文件。", opened),
        changed_files: vec![],
    })
}

#[tauri::command]
fn run_exercise(
    project_id: Option<String>,
    track_id: Option<String>,
    exercise_id: Option<String>,
) -> Result<RunResult, String> {
    let (_root, projects) = load_workspace()?;
    let selection = resolve_selection(
        &projects,
        project_id.as_deref(),
        track_id.as_deref(),
        exercise_id.as_deref(),
    )?;
    let Some(exercise) = selection.exercise else {
        return Err("还没有可运行的练习。".to_string());
    };

    let mut command = Command::new("node");
    command
        .arg(&exercise.run.file)
        .args(&exercise.run.args)
        .current_dir(&selection.project.dir);

    let output = command.output().map_err(|error| error.to_string())?;
    let command_text = std::iter::once("node".to_string())
        .chain(std::iter::once(exercise.run.file.clone()))
        .chain(exercise.run.args.clone())
        .collect::<Vec<_>>()
        .join(" ");

    Ok(RunResult {
        command: command_text,
        status: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[tauri::command]
fn save_memo(
    project_id: Option<String>,
    title: String,
    body: String,
    tags: Vec<String>,
    time: String,
) -> Result<CommandResult, String> {
    let (_root, projects) = load_workspace()?;
    let project = resolve_project(&projects, project_id.as_deref())?;
    let title = title.trim();
    let body = body.trim();

    if title.is_empty() || body.is_empty() {
        return Err("标题和正文都要写。".to_string());
    }

    let memo_path = project.dir.join(project.memos_file());
    if let Some(parent) = memo_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let clean_tags = tags
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    let tag_text = if clean_tags.is_empty() {
        "无".to_string()
    } else {
        clean_tags.join("、")
    };
    let entry = format!(
        "\n## {title}\n\n时间：{}\n标签：{}\n\n{}\n",
        time.trim(),
        tag_text,
        body
    );

    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&memo_path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, entry.as_bytes()))
        .map_err(|error| error.to_string())?;

    Ok(CommandResult {
        message: "已保存锚点记录。".to_string(),
        changed_files: vec![format!("{}/{}", project.id, project.memos_file())],
    })
}

#[tauri::command]
fn set_project_meta(
    project_id: String,
    display_name: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
) -> Result<CommandResult, String> {
    let (_root, projects) = load_workspace()?;
    let project = resolve_project(&projects, Some(&project_id))?;
    let config_path = project.dir.join("tracekata.json");
    let text = fs::read_to_string(&config_path).map_err(|error| error.to_string())?;
    let mut raw: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| error.to_string())?;

    if let Some(name) = display_name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("项目名不能为空。".to_string());
        }
        raw["name"] = serde_json::Value::String(name);
    }

    if let Some(value) = pinned {
        raw["pinned"] = serde_json::Value::Bool(value);
    }

    if let Some(value) = archived {
        raw["archived"] = serde_json::Value::Bool(value);
    }

    let pretty = serde_json::to_string_pretty(&raw).map_err(|error| error.to_string())?;
    fs::write(&config_path, format!("{pretty}\n")).map_err(|error| error.to_string())?;

    Ok(CommandResult {
        message: "已更新项目设置。".to_string(),
        changed_files: vec![format!("{}/tracekata.json", project.id)],
    })
}

#[tauri::command]
fn open_workspace_in_vscode() -> Result<CommandResult, String> {
    let (root, _projects) = load_workspace()?;

    // 打开整个工作区文件夹，而不是单个文件
    if Command::new("code")
        .arg(&root)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
    {
        return Ok(CommandResult {
            message: format!("已在 VSCode 打开 {}", root.to_string_lossy()),
            changed_files: vec![],
        });
    }

    let status = Command::new("open")
        .arg("-a")
        .arg("Visual Studio Code")
        .arg(&root)
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(CommandResult {
            message: format!("已在 VSCode 打开 {}", root.to_string_lossy()),
            changed_files: vec![],
        })
    } else {
        Err("没有成功打开 VSCode。".to_string())
    }
}

#[tauri::command]
fn reveal_project(project_id: Option<String>) -> Result<CommandResult, String> {
    let (_root, projects) = load_workspace()?;
    let project = resolve_project(&projects, project_id.as_deref())?;

    let status = Command::new("open")
        .arg(&project.dir)
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(CommandResult {
            message: "已在 Finder 中打开。".to_string(),
            changed_files: vec![],
        })
    } else {
        Err("没有成功打开 Finder。".to_string())
    }
}

fn build_dashboard_state(
    project_id: Option<&str>,
    track_id: Option<&str>,
    exercise_id: Option<&str>,
) -> Result<DashboardState, String> {
    let (root, projects) = load_workspace()?;

    if projects.is_empty() {
        return Ok(DashboardState {
            workspace_root: root.to_string_lossy().to_string(),
            projects: vec![],
            current_project_id: None,
            current_track: None,
            track_exercises: vec![],
            current_exercise: None,
            base_hint: "还没有练习项目。让 Claude Code 或 Codex 帮你建一个。".to_string(),
            file_groups: vec![],
            memos: vec![],
            ai_skills: read_ai_skills(),
        });
    }

    let selection = resolve_selection(&projects, project_id, track_id, exercise_id)?;
    let project = selection.project;
    let base = selection
        .exercise
        .and_then(|exercise| get_base_exercise(&project.config, exercise));
    let base_hint = build_base_hint(selection.track, selection.exercise, base);
    let file_groups = selection
        .exercise
        .map(|exercise| build_file_groups(project, exercise, base))
        .unwrap_or_default();
    let track_exercises = selection
        .track
        .map(|track| build_exercise_list(project, track))
        .unwrap_or_default();
    let memos = read_memos(&project.dir.join(project.memos_file()));

    Ok(DashboardState {
        workspace_root: root.to_string_lossy().to_string(),
        projects: projects.iter().map(project_list_item).collect(),
        current_project_id: Some(project.id.clone()),
        current_track: selection.track.map(|track| TrackSummary {
            id: track.id.clone(),
            title: track.title.clone(),
            base_offset: track.base_offset,
            exercise_ids: track.exercise_ids.clone(),
        }),
        track_exercises,
        current_exercise: selection.exercise.map(exercise_summary),
        base_hint,
        file_groups,
        memos,
        ai_skills: read_ai_skills(),
    })
}

fn load_workspace() -> Result<(PathBuf, Vec<Project>), String> {
    let root = find_workspace_root()?;
    let projects = scan_projects(&root);
    Ok((root, projects))
}

fn find_workspace_root() -> Result<PathBuf, String> {
    if let Ok(value) = env::var("TRACEKATA_WORKSPACE_ROOT") {
        let candidate = PathBuf::from(value);
        if !scan_projects(&candidate).is_empty() {
            return Ok(candidate);
        }
    }

    let mut starts = vec![];

    if let Ok(current) = env::current_dir() {
        starts.push(current);
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }

    for start in starts {
        let mut current = start.clone();
        loop {
            if !scan_projects(&current).is_empty() {
                return Ok(current);
            }
            if !current.pop() {
                break;
            }
        }
    }

    Err("没有找到练习项目（含 tracekata.json 的目录）。".to_string())
}

fn scan_projects(root: &Path) -> Vec<Project> {
    let Ok(entries) = fs::read_dir(root) else {
        return vec![];
    };

    let mut projects = vec![];

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }

        let config_path = dir.join("tracekata.json");
        if !config_path.exists() {
            continue;
        }

        let Ok(text) = fs::read_to_string(&config_path) else {
            continue;
        };
        let Ok(config) = serde_json::from_str::<ProjectConfig>(&text) else {
            continue;
        };

        projects.push(Project {
            id: name,
            dir,
            config,
        });
    }

    // 置顶的排前面，其余按目录名
    projects.sort_by(|a, b| {
        b.config
            .pinned
            .cmp(&a.config.pinned)
            .then_with(|| a.id.cmp(&b.id))
    });
    projects
}

fn resolve_project<'a>(
    projects: &'a [Project],
    project_id: Option<&str>,
) -> Result<&'a Project, String> {
    if let Some(id) = project_id {
        if let Some(project) = projects.iter().find(|project| project.id == id) {
            return Ok(project);
        }
    }

    projects
        .iter()
        .find(|project| !project.config.archived)
        .or_else(|| projects.first())
        .ok_or_else(|| "还没有练习项目。".to_string())
}

fn resolve_selection<'a>(
    projects: &'a [Project],
    project_id: Option<&str>,
    track_id: Option<&str>,
    exercise_id: Option<&str>,
) -> Result<Selection<'a>, String> {
    let project = resolve_project(projects, project_id)?;
    let config = &project.config;

    let track = track_id
        .and_then(|id| config.tracks.iter().find(|track| track.id == id))
        .or_else(|| {
            // 默认拿最近创建的轨道
            let mut sorted: Vec<&ProgressiveTrack> = config.tracks.iter().collect();
            sorted.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            sorted.first().copied()
        });

    let exercise = exercise_id
        .and_then(|id| config.exercises.iter().find(|exercise| exercise.id == id))
        .or_else(|| {
            track
                .and_then(|track| track.exercise_ids.last())
                .and_then(|id| config.exercises.iter().find(|exercise| &exercise.id == id))
        })
        .or_else(|| config.exercises.last());

    Ok(Selection {
        project,
        track,
        exercise,
    })
}

fn project_list_item(project: &Project) -> ProjectListItem {
    let mut tracks = project
        .config
        .tracks
        .iter()
        .map(|track| TrackListItem {
            id: track.id.clone(),
            title: track.title.clone(),
            created_at: track.created_at.clone(),
            exercise_count: track.exercise_ids.len(),
        })
        .collect::<Vec<_>>();

    tracks.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    ProjectListItem {
        id: project.id.clone(),
        display_name: project.display_name(),
        pinned: project.config.pinned,
        archived: project.config.archived,
        tracks,
    }
}

fn get_base_exercise<'a>(config: &'a ProjectConfig, exercise: &Exercise) -> Option<&'a Exercise> {
    if let Some(track) = config
        .tracks
        .iter()
        .find(|track| track.exercise_ids.iter().any(|id| id == &exercise.id))
    {
        if let Some(index) = track.exercise_ids.iter().position(|id| id == &exercise.id) {
            if index >= track.base_offset {
                if let Some(base_id) = track.exercise_ids.get(index - track.base_offset) {
                    if let Some(base) = config.exercises.iter().find(|item| &item.id == base_id) {
                        return Some(base);
                    }
                }
            }
        }
    }

    exercise
        .base_from
        .as_ref()
        .and_then(|id| config.exercises.iter().find(|item| &item.id == id))
}

fn build_base_hint(
    track: Option<&ProgressiveTrack>,
    exercise: Option<&Exercise>,
    base: Option<&Exercise>,
) -> String {
    let Some(exercise) = exercise else {
        return "还没有当前练习。".to_string();
    };
    let Some(base) = base else {
        return "这一题从空白起步。".to_string();
    };
    let Some(track) = track else {
        return format!("这一题先复习 {}。", base.id);
    };

    if let Some(index) = track.exercise_ids.iter().position(|id| id == &exercise.id) {
        if index >= track.base_offset {
            return format!(
                "这次使用 {} 个版本前的 {} 作为基底。",
                track.base_offset, base.id
            );
        }
    }

    format!(
        "当前轨道还没有 {} 个版本前，先用 {} 作为基底。",
        track.base_offset, base.id
    )
}

fn build_exercise_list(project: &Project, track: &ProgressiveTrack) -> Vec<ExerciseListItem> {
    track
        .exercise_ids
        .iter()
        .filter_map(|id| {
            project
                .config
                .exercises
                .iter()
                .find(|exercise| &exercise.id == id)
        })
        .map(|exercise| {
            // 所有手敲文件都写了内容，就算这一题练过了
            let finished = !exercise.practice_files.is_empty()
                && exercise.practice_files.iter().all(|file| {
                    let item = file_item(project, file, "practice");
                    item.exists && !item.is_empty
                });

            ExerciseListItem {
                id: exercise.id.clone(),
                title: exercise.title.clone(),
                finished,
            }
        })
        .collect()
}

fn build_file_groups(
    project: &Project,
    exercise: &Exercise,
    base: Option<&Exercise>,
) -> Vec<FileGroup> {
    let mut groups = vec![
        FileGroup {
            kind: "practice".to_string(),
            files: exercise
                .practice_files
                .iter()
                .map(|file| file_item(project, file, "practice"))
                .collect(),
        },
        FileGroup {
            kind: "reference".to_string(),
            files: vec![file_item(project, &project.index_file(), "index")],
        },
    ];

    if let Some(base) = base {
        groups.push(FileGroup {
            kind: "base".to_string(),
            files: base
                .practice_files
                .iter()
                .map(|file| file_item(project, file, "base"))
                .collect(),
        });
    }

    groups.push(FileGroup {
        kind: "demo".to_string(),
        files: exercise
            .demo_files
            .iter()
            .map(|file| file_item(project, file, "demo"))
            .collect(),
    });

    groups
}

fn file_item(project: &Project, file: &str, kind: &str) -> FileItem {
    let path = project.dir.join(file);
    let text = fs::read_to_string(&path).unwrap_or_default();
    let exists = path.exists();
    let is_empty = !exists || text.trim().is_empty();
    let line_count = if exists { text.lines().count() } else { 0 };
    let name = Path::new(file)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file)
        .to_string();

    FileItem {
        name,
        relative_path: format!("{}/{}", project.id, file),
        kind: kind.to_string(),
        exists,
        is_empty,
        line_count,
    }
}

fn read_memos(path: &Path) -> Vec<MemoEntry> {
    let Ok(text) = fs::read_to_string(path) else {
        return vec![];
    };
    let mut memos = vec![];
    let mut current: Option<MemoEntry> = None;
    let mut body_lines: Vec<String> = vec![];

    for line in text.lines() {
        if let Some(title) = line.strip_prefix("## ") {
            if let Some(mut memo) = current.take() {
                memo.body = body_lines.join("\n").trim().to_string();
                memos.push(memo);
            }
            current = Some(MemoEntry {
                title: title.trim().to_string(),
                body: String::new(),
                time: String::new(),
                tags: vec![],
            });
            body_lines.clear();
            continue;
        }

        let Some(memo) = current.as_mut() else {
            continue;
        };

        if let Some(value) = line.strip_prefix("时间：") {
            memo.time = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("标签：") {
            memo.tags = value
                .split(['、', ',', ' '])
                .map(|tag| tag.trim().to_string())
                .filter(|tag| !tag.is_empty() && tag != "无")
                .collect();
        } else if !line.trim().is_empty() {
            body_lines.push(line.to_string());
        }
    }

    if let Some(mut memo) = current {
        memo.body = body_lines.join("\n").trim().to_string();
        memos.push(memo);
    }

    memos.into_iter().rev().collect()
}

fn read_ai_skills() -> Vec<AiSkill> {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return vec![];
    };
    let mut skill_files = vec![];
    let codex_home = home.join(".codex");

    collect_skill_files(&codex_home.join("skills"), 0, 5, &mut skill_files);
    collect_skill_files(&codex_home.join("plugins/cache"), 0, 9, &mut skill_files);

    let mut skills = skill_files
        .into_iter()
        .filter_map(|path| parse_skill_file(&path))
        .collect::<Vec<_>>();

    skills.sort_by(|a, b| {
        a.source
            .cmp(&b.source)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    skills.dedup_by(|a, b| a.name == b.name && a.path == b.path);
    skills.truncate(40);
    skills
}

fn collect_skill_files(dir: &Path, depth: usize, max_depth: usize, files: &mut Vec<PathBuf>) {
    if depth > max_depth || files.len() >= 80 || !dir.exists() {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        if files.len() >= 80 {
            return;
        }

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name == "node_modules" || name == "target" || name == ".git" {
            continue;
        }

        if path.is_file() && name == "SKILL.md" {
            files.push(path);
        } else if path.is_dir() {
            collect_skill_files(&path, depth + 1, max_depth, files);
        }
    }
}

fn parse_skill_file(path: &Path) -> Option<AiSkill> {
    let text = fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }

    let mut name = String::new();
    let mut description = String::new();

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }

        if let Some(value) = trimmed.strip_prefix("name:") {
            name = clean_frontmatter_value(value);
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            description = clean_frontmatter_value(value);
        }
    }

    if name.is_empty() {
        name = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("未命名技能")
            .to_string();
    }

    let path_text = path.to_string_lossy().to_string();
    let source = if path_text.contains("/plugins/cache/") {
        "插件技能"
    } else if path_text.contains("/skills/.system/") {
        "系统技能"
    } else {
        "个人技能"
    };

    Some(AiSkill {
        name,
        description,
        source: source.to_string(),
        path: path_text,
    })
}

fn clean_frontmatter_value(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

fn open_with_vscode(path: &Path) -> Result<(), String> {
    if Command::new("code")
        .arg("-r")
        .arg(path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
    {
        return Ok(());
    }

    let status = Command::new("open")
        .arg("-a")
        .arg("Visual Studio Code")
        .arg(path)
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("没有成功打开 VSCode。".to_string())
    }
}

fn exercise_summary(exercise: &Exercise) -> ExerciseSummary {
    ExerciseSummary {
        id: exercise.id.clone(),
        title: exercise.title.clone(),
        base_from: exercise.base_from.clone(),
        practice_files: exercise.practice_files.clone(),
        demo_files: exercise.demo_files.clone(),
        run_file: exercise.run.file.clone(),
        run_args: exercise.run.args.clone(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_dashboard_state,
            prepare_exercise,
            open_workspace_file,
            open_exercise_scene,
            run_exercise,
            save_memo,
            set_project_meta,
            reveal_project,
            open_workspace_in_vscode,
            claude::detect_claude_cli,
            claude::detect_codex_cli,
            claude::list_models,
            claude::send_chat_message,
            claude::list_chat_sessions,
            claude::load_chat_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_discovers_typescript_practice() {
        let (_root, projects) = load_workspace().expect("workspace should load");
        assert!(projects
            .iter()
            .any(|project| project.id == "typescript-practice"));
    }

    #[test]
    fn dashboard_state_defaults_to_latest_exercise() {
        let state =
            build_dashboard_state(None, None, None).expect("dashboard state should load");

        assert_eq!(state.current_project_id.as_deref(), Some("typescript-practice"));
        let exercise = state
            .current_exercise
            .expect("current exercise should exist");
        assert_eq!(exercise.id, "014");
        // 轨道补全 001-010 后，baseOffset 5 真正生效：014 的基底是 5 题前的 009
        assert!(state.base_hint.contains("009"));
    }

    #[test]
    fn dashboard_state_lists_practice_and_demo_files() {
        let state =
            build_dashboard_state(None, None, None).expect("dashboard state should load");
        let files = state
            .file_groups
            .into_iter()
            .flat_map(|group| group.files)
            .map(|file| file.name)
            .collect::<Vec<_>>();

        assert!(files.contains(&"014.js".to_string()));
        assert!(files.contains(&"014-commands-data.js".to_string()));
        assert!(files.contains(&"题目索引.md".to_string()));
    }
}
