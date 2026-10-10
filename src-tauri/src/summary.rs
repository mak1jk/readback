//! Cheap, streaming per-file summaries for the session list. Full parsing happens in the
//! frontend adapter only when a session is opened; multi-GB session folders stay fast.

use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    pub reasoning: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub repo: String,
    pub branch: String,
    pub model: String,
    pub cli: String,
    /// ISO-8601 timestamps of the first and last event.
    pub started: Option<String>,
    pub ended: Option<String>,
    pub turns: u32,
    pub tokens: Option<Tokens>,
}

const CTX_PREFIXES: [&str; 4] = ["# AGENTS.md", "<environment_context>", "# Context from my IDE setup", "<user_instructions>"];

fn timestamp(line: &str) -> Option<&str> {
    let key = "\"timestamp\":\"";
    let i = line.find(key)? + key.len();
    let n = line[i..].find('"')?;
    Some(&line[i..i + n])
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    let mut cur = v;
    for k in path {
        match cur.get(k) {
            Some(x) => cur = x,
            None => return "",
        }
    }
    cur.as_str().unwrap_or("")
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().map(|p| p.get("text").and_then(Value::as_str).unwrap_or("")).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Summarize a Codex rollout. Mirrors the turn/title rules of `src/adapters/codex.ts`
/// closely enough for the list view; returns `None` for files without a real prompt.
pub fn codex(path: &Path) -> Option<Summary> {
    let file = std::fs::File::open(path).ok()?;
    let mut s = Summary::default();
    let mut started: Option<String> = None;
    let mut ended: Option<String> = None;
    for line in BufReader::with_capacity(1 << 20, file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(ts) = timestamp(&line) {
            if started.as_deref().map_or(true, |x| ts < x) {
                started = Some(ts.to_owned());
            }
            if ended.as_deref().map_or(true, |x| ts > x) {
                ended = Some(ts.to_owned());
            }
        }
        // Only decode the line kinds the summary needs; tool output lines can be huge.
        let wanted = line.contains("\"session_meta\"")
            || (s.model.is_empty() && line.contains("\"turn_context\""))
            || line.contains("\"token_count\"")
            || (line.contains("\"role\":\"user\"") && line.contains("\"response_item\""));
        if !wanted {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let p = v.get("payload").cloned().unwrap_or(Value::Null);
        match str_at(&v, &["type"]) {
            "session_meta" => {
                s.id = p.get("id").or_else(|| p.get("session_id")).and_then(Value::as_str).unwrap_or("").to_owned();
                s.cwd = str_at(&p, &["cwd"]).to_owned();
                s.cli = str_at(&p, &["cli_version"]).to_owned();
                s.branch = str_at(&p, &["git", "branch"]).to_owned();
                // Same rule as the TS adapter: strip a GitHub host prefix and a trailing ".git".
                let url = str_at(&p, &["git", "repository_url"]);
                let short = ["https://", "http://"]
                    .iter()
                    .find_map(|pre| url.strip_prefix(pre))
                    .map(|u| u.strip_prefix("www.").unwrap_or(u))
                    .and_then(|u| u.strip_prefix("github.com/"))
                    .unwrap_or(url);
                s.repo = short.strip_suffix(".git").unwrap_or(short).to_owned();
            }
            "turn_context" => {
                if s.model.is_empty() {
                    s.model = str_at(&p, &["model"]).to_owned();
                }
            }
            "event_msg" => {
                if let Some(t) = p.get("info").and_then(|i| i.get("total_token_usage")) {
                    let n = |k: &str| t.get(k).and_then(Value::as_u64).unwrap_or(0);
                    s.tokens = Some(Tokens { input: n("input_tokens"), cached: n("cached_input_tokens"), output: n("output_tokens"), reasoning: n("reasoning_output_tokens") });
                }
            }
            "response_item" if str_at(&p, &["type"]) == "message" && str_at(&p, &["role"]) == "user" => {
                let mut tx = text_of(p.get("content").unwrap_or(&Value::Null));
                if let Some(i) = tx.find("## My request for Codex:") {
                    tx = tx[i + 24..].trim().to_owned();
                }
                let t = tx.trim();
                if t.is_empty() || CTX_PREFIXES.iter().any(|k| t.starts_with(k)) || t.starts_with("This session is being continued") {
                    continue;
                }
                s.turns += 1;
                if s.title.is_empty() {
                    s.title = t.lines().next().unwrap_or("").chars().take(120).collect();
                }
            }
            _ => {}
        }
    }
    if s.turns == 0 {
        return None;
    }
    s.started = started;
    s.ended = ended;
    Some(s)
}

/// External JSONL agents are summarized one row at a time. Pi retains only light
/// ancestry records so alternate branches cannot inflate the session list.
pub fn external(agent: &str, path: &Path) -> Option<Summary> {
    match agent {
        "claude" => claude(path),
        "pi" => pi(path),
        "gemini" => gemini(path),
        "opencode" => opencode(path),
        "aider" => aider(path),
        _ => None,
    }
}

fn n(v: &Value, key: &str) -> u64 { v.get(key).and_then(Value::as_u64).unwrap_or(0) }
fn add_tokens(s: &mut Summary, u: Tokens) {
    let total = s.tokens.get_or_insert_with(Tokens::default);
    total.input += u.input;
    total.cached += u.cached;
    total.output += u.output;
    total.reasoning += u.reasoning;
}
fn prompt(s: &mut Summary, text: String) {
    if text.trim().is_empty() { return; }
    s.turns += 1;
    if s.title.is_empty() { s.title = text.trim().lines().next().unwrap_or("").chars().take(120).collect(); }
}
fn finish(s: Summary) -> Option<Summary> { if s.turns > 0 { Some(s) } else { None } }
fn stamp(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned).or_else(|| v.as_u64().map(|n| n.to_string()))
}
fn event_time(s: &mut Summary, v: &Value) {
    if let Some(ts) = stamp(v) {
        if s.started.as_ref().map_or(true, |x| &ts < x) { s.started = Some(ts.clone()); }
        if s.ended.as_ref().map_or(true, |x| &ts > x) { s.ended = Some(ts); }
    }
}
fn for_rows(path: &Path, mut f: impl FnMut(Value)) -> Option<()> {
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::with_capacity(1 << 20, file).lines().map_while(Result::ok) {
        if let Ok(v) = serde_json::from_str::<Value>(&line) { f(v); }
    }
    Some(())
}
fn claude(path: &Path) -> Option<Summary> {
    let mut s = Summary::default();
    let mut usages = std::collections::HashMap::new();
    let mut seen = std::collections::HashSet::new();
    for_rows(path, |r| {
        event_time(&mut s, &r["timestamp"]);
        for (key, target) in [("sessionId", &mut s.id), ("cwd", &mut s.cwd), ("gitBranch", &mut s.branch), ("version", &mut s.cli)] {
            if let Some(v) = r[key].as_str() { *target = v.to_owned(); }
        }
        if str_at(&r, &["type"]) == "ai-title" {
            if let Some(v) = r["aiTitle"].as_str() { s.title = v.to_owned(); }
        }
        if let Some(id) = r["uuid"].as_str() { if !seen.insert(id.to_owned()) { return; } }
        match str_at(&r, &["type"]) {
            "user" if r["isMeta"] != true => prompt(&mut s, text_of(&r["message"]["content"])),
            "assistant" => {
                if let Some(model) = r["message"]["model"].as_str() { s.model = model.to_owned(); }
                if let Some(u) = r["message"].get("usage") {
                    let id = str_at(&r, &["message", "id"]);
                    let key = if id.is_empty() { usages.len().to_string() } else { id.to_owned() };
                    usages.insert(key, Tokens { input: n(u, "input_tokens") + n(u, "cache_read_input_tokens") + n(u, "cache_creation_input_tokens"), cached: n(u, "cache_read_input_tokens"), output: n(u, "output_tokens"), reasoning: 0 });
                }
            }
            _ => {}
        }
    })?;
    for u in usages.into_values() { add_tokens(&mut s, u); }
    finish(s)
}
#[derive(Default)]
struct PiBrief { id: String, parent: String, text: String, model: String, cli: String, timestamp: Value, tokens: Option<Tokens> }
fn pi(path: &Path) -> Option<Summary> {
    let mut s = Summary::default();
    let mut entries = Vec::new();
    let mut tree = false;
    let mut valid = false;
    for_rows(path, |r| {
        if str_at(&r, &["type"]) == "session" {
            valid = true;
            s.id = str_at(&r, &["id"]).to_owned();
            s.cwd = str_at(&r, &["cwd"]).to_owned();
            event_time(&mut s, &r["timestamp"]);
            return;
        }
        tree |= r.get("parentId").is_some();
        let mut e = PiBrief { id: str_at(&r, &["id"]).to_owned(), parent: str_at(&r, &["parentId"]).to_owned(), timestamp: r["timestamp"].clone(), ..PiBrief::default() };
        if str_at(&r, &["type"]) == "model_change" { e.model = str_at(&r, &["modelId"]).to_owned(); }
        if str_at(&r, &["type"]) == "session_info" { e.cli = str_at(&r, &["name"]).to_owned(); }
        if str_at(&r, &["message", "role"]) == "user" { e.text = text_of(&r["message"]["content"]); }
        if str_at(&r, &["message", "role"]) == "assistant" {
            e.model = str_at(&r, &["message", "model"]).to_owned();
            if let Some(u) = r["message"].get("usage") { e.tokens = Some(Tokens { input: n(u, "input") + n(u, "cacheRead") + n(u, "cacheWrite"), cached: n(u, "cacheRead"), output: n(u, "output"), reasoning: n(u, "reasoning") }); }
        }
        entries.push(e);
    })?;
    if !valid { return None; }
    let mut active: Vec<usize> = (0..entries.len()).collect();
    if tree && !entries.is_empty() {
        let index: std::collections::HashMap<_, _> = entries.iter().enumerate().map(|(i, e)| (e.id.as_str(), i)).collect();
        let mut seen = std::collections::HashSet::new();
        active.clear();
        let mut next = Some(entries.len() - 1);
        while let Some(i) = next {
            if !seen.insert(i) { break; }
            active.push(i);
            next = index.get(entries[i].parent.as_str()).copied();
        }
        active.reverse();
    }
    for i in active {
        let e = &entries[i];
        event_time(&mut s, &e.timestamp);
        prompt(&mut s, e.text.clone());
        if !e.model.is_empty() { s.model = e.model.clone(); }
        if !e.cli.is_empty() { s.title = e.cli.clone(); }
        if let Some(u) = &e.tokens { add_tokens(&mut s, u.clone()); }
    }
    finish(s)
}
fn gemini(path: &Path) -> Option<Summary> {
    let source = std::fs::read_to_string(path).ok()?;
    let mut record: Value = serde_json::from_str(&source).unwrap_or(Value::Null);
    if !record["messages"].is_array() {
        record = serde_json::json!({"messages": []});
        let mut messages: Vec<Value> = vec![];
        for line in source.lines() {
            let Ok(r) = serde_json::from_str::<Value>(line) else { continue };
            if r.get("sessionId").is_some() || r.get("$set").is_some() {
                let meta = r.get("$set").unwrap_or(&r);
                if let Some(obj) = meta.as_object() { for (k, v) in obj { record[k] = v.clone(); } }
                if let Some(msgs) = meta["messages"].as_array() { messages = msgs.clone(); }
            } else if let Some(id) = r["$rewindTo"].as_str() {
                if let Some(i) = messages.iter().position(|m| m["id"] == id) { messages.truncate(i); } else { messages.clear(); }
            } else if let Some(patch) = r.get("$patch") {
                let mut updates = vec![patch.clone()];
                if let Some(more) = patch["updates"].as_array() { updates.extend(more.iter().cloned()); }
                for u in updates {
                    if let Some(m) = messages.iter_mut().find(|m| m["id"] == u["id"]) {
                        if u.get("content").is_some() { m["content"] = u["content"].clone(); }
                    }
                }
                if let Some(ids) = patch["removeIds"].as_array() { messages.retain(|m| !ids.contains(&m["id"])); }
                if let Some(ids) = patch["orderIds"].as_array() {
                    let mut ordered: Vec<Value> = messages.iter().filter(|m| !ids.contains(&m["id"])).cloned().collect();
                    ordered.extend(ids.iter().filter_map(|id| messages.iter().find(|m| &m["id"] == id).cloned()));
                    messages = ordered;
                }
            } else if r.get("id").is_some() && r.get("type").is_some() {
                if let Some(i) = messages.iter().position(|m| m["id"] == r["id"]) { messages[i] = r; } else { messages.push(r); }
            }
        }
        record["messages"] = Value::Array(messages);
    }
    if record["sessionId"].as_str().is_none() { return None; }
    let mut s = Summary { id: str_at(&record, &["sessionId"]).to_owned(), cwd: record["directories"][0].as_str().unwrap_or("").to_owned(), started: stamp(&record["startTime"]), ended: stamp(&record["lastUpdated"]), ..Summary::default() };
    for m in record["messages"].as_array()? {
        event_time(&mut s, &m["timestamp"]);
        if m["type"] == "user" { prompt(&mut s, text_of(&m["content"])); }
        if m["type"] == "gemini" {
            if let Some(model) = m["model"].as_str() { s.model = model.to_owned(); }
            if let Some(u) = m.get("tokens").filter(|v| !v.is_null()) { add_tokens(&mut s, Tokens { input: n(u, "input"), cached: n(u, "cached"), output: n(u, "output"), reasoning: n(u, "thoughts") }); }
        }
    }
    finish(s)
}
fn opencode(path: &Path) -> Option<Summary> {
    let v: Value = serde_json::from_reader(std::fs::File::open(path).ok()?).ok()?;
    let info = &v["info"];
    if info["id"].as_str().is_none() { return None; }
    let mut s = Summary { id: str_at(info, &["id"]).to_owned(), title: str_at(info, &["title"]).to_owned(), cwd: str_at(info, &["directory"]).to_owned(), cli: str_at(info, &["version"]).to_owned(), started: stamp(&info["time"]["created"]), ended: stamp(&info["time"]["updated"]), ..Summary::default() };
    for m in v["messages"].as_array()? {
        let info = &m["info"];
        event_time(&mut s, &info["time"]["created"]);
        if info["role"] == "user" { prompt(&mut s, text_of(&m["parts"])); }
        if info["role"] == "assistant" {
            if let Some(model) = info["modelID"].as_str() { s.model = model.to_owned(); }
            if let Some(u) = info.get("tokens") { add_tokens(&mut s, Tokens { input: n(u, "input") + n(&u["cache"], "read") + n(&u["cache"], "write"), cached: n(&u["cache"], "read"), output: n(u, "output"), reasoning: n(u, "reasoning") }); }
        }
    }
    finish(s)
}
fn aider(path: &Path) -> Option<Summary> {
    let file = std::fs::File::open(path).ok()?;
    let mut s = Summary::default();
    let mut valid = false;
    let mut fence: Option<(char, usize)> = None;
    let mut continuation = false;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let c = trimmed.chars().next().unwrap();
            let len = trimmed.chars().take_while(|x| *x == c).count();
            match fence { None => fence = Some((c, len)), Some((mark, size)) if c == mark && len >= size => fence = None, _ => {} }
            continuation = false;
        } else if fence.is_none() {
            if let Some(ts) = line.strip_prefix("# aider chat started at ") {
                valid = true;
                event_time(&mut s, &Value::String(ts.trim().replacen(' ', "T", 1)));
                continuation = false;
            } else if let Some(text) = line.strip_prefix("#### ") {
                if !continuation { prompt(&mut s, text.to_owned()); }
                continuation = line.ends_with("  ");
            } else { continuation = false; }
        }
    }
    if valid { finish(s) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    fn read(agent: &str, source: &str) -> Option<Summary> {
        let p = std::env::temp_dir().join(format!("session-explorer-{}-{}.txt", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        std::fs::write(&p, source).unwrap();
        let result = crate::summarize(agent, &p);
        std::fs::remove_file(p).unwrap();
        result
    }
    #[test]
    fn claude_tool_results_do_not_count_as_prompts() {
        let s = read("claude", r#"{"type":"user","sessionId":"c","cwd":"/demo","timestamp":"2026-10-10T10:00:00Z","message":{"content":"Check tests"}}
{"type":"assistant","timestamp":"2026-10-10T10:00:01Z","message":{"id":"m","model":"claude-test","usage":{"input_tokens":20,"cache_read_input_tokens":10,"output_tokens":5}}}
{"type":"assistant","timestamp":"2026-10-10T10:00:02Z","message":{"id":"m","usage":{"input_tokens":20,"cache_read_input_tokens":10,"output_tokens":5}}}
{"type":"user","timestamp":"2026-10-10T10:00:03Z","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}"#).unwrap();
        assert_eq!(s.turns, 1);
        assert_eq!(s.title, "Check tests");
        assert_eq!(s.tokens.unwrap().input, 30);
    }
    #[test]
    fn pi_follows_latest_branch() {
        let s = read("pi", r#"{"type":"session","id":"p","cwd":"/demo","timestamp":"2026-10-10T10:00:00Z"}
{"type":"message","id":"old","parentId":null,"message":{"role":"user","content":"Discarded"}}
{"type":"message","id":"new","parentId":null,"message":{"role":"user","content":"Active"}}
{"type":"message","id":"a","parentId":"new","message":{"role":"assistant","content":[]}}"#).unwrap();
        assert_eq!(s.turns, 1);
        assert_eq!(s.title, "Active");
    }
    #[test]
    fn gemini_reads_snapshot_and_jsonl_rewinds() {
        let s = read("gemini", r#"{"sessionId":"g","startTime":"2026-10-10T10:00:00Z","messages":[{"type":"user","content":[{"text":"Read config"}]}]}"#).unwrap();
        assert_eq!(s.title, "Read config");
        let s = read("gemini", r#"{"sessionId":"g","startTime":"2026-10-10T10:00:00Z"}
{"id":"u","type":"user","content":"Keep"}
{"id":"a","type":"gemini","content":"Reply"}
{"id":"v","type":"user","content":"Discard"}
{"$rewindTo":"v"}"#).unwrap();
        assert_eq!(s.turns, 1);
    }
    #[test]
    fn opencode_requires_export_and_aider_ignores_fenced_headings() {
        assert!(read("opencode", r#"{"id":"storage-fragment","title":"Fragment"}"#).is_none());
        let s = read("opencode", r#"{"info":{"id":"o","title":"Export","directory":"/demo","time":{"created":1791626400000}},"messages":[{"info":{"role":"user"},"parts":[{"type":"text","text":"Hi"}]}]}"#).unwrap();
        assert_eq!(s.turns, 1);
        let s = read("aider", "# aider chat started at 2026-10-10 10:00:00\n#### Fix  \n#### this\nReply\n```md\n#### not a prompt\n```\n#### Thanks\nDone\n").unwrap();
        assert_eq!(s.turns, 2);
        assert_eq!(s.title, "Fix");
    }
    #[test]
    fn gemini_partial_reordering_and_unknown_rewind_match_the_recording_format() {
        let s = read("gemini", r#"{"$set":{"sessionId":"g","startTime":"2026-10-10T10:00:00Z"}}
{"id":"u","type":"user","content":"Keep the prompt"}
{"id":"a","type":"gemini","content":"First"}
{"id":"b","type":"gemini","content":"Second"}
{"$patch":{"orderIds":["b","a"]}}"#).unwrap();
        assert_eq!(s.title, "Keep the prompt");
        assert_eq!(s.turns, 1);
        assert!(read("gemini", r#"{"sessionId":"g"}
{"id":"u","type":"user","content":"Removed"}
{"$rewindTo":"unknown"}"#).is_none());
    }
}
