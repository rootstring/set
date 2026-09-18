use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use serde_json::{json, Value};

const REPLY_TIMEOUT: Duration = Duration::from_secs(20);

struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "set_mcp_stdio_{}_{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Fixture { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    fn notes(&self) -> PathBuf {
        self.dir.join("notes")
    }

    fn config_dir(&self) -> PathBuf {
        let home = self.home();
        if cfg!(target_os = "windows") {
            home.join("AppData").join("Roaming").join(APP_DIR)
        } else if cfg!(target_os = "macos") {
            home.join("Library")
                .join("Application Support")
                .join(APP_DIR)
        } else {
            home.join(".config").join(APP_DIR)
        }
    }

    fn page(&self, rel: &str, id: &str, title: &str, order: u32, body: &str) -> &Self {
        let path = self.notes().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(
                "---\nid: {id:?}\ntitle: {title:?}\norder: {order}\ncreatedAt: 1000\nupdatedAt: 2000\n---\n\n{body}"
            ),
        )
        .unwrap();
        self
    }

    fn seed(&self) -> &Self {
        self.page(
            "Work/Projects.md",
            "p",
            "Projects",
            0,
            "Top level container.\n",
        )
        .page(
            "Work/Projects/Project Alpha.md",
            "a",
            "Project Alpha",
            0,
            "The alpha rollout plan.\nBudget approved.\n",
        )
        .page(
            "Work/Projects/Project Beta.md",
            "b",
            "Project Beta",
            1,
            "Beta is blocked on the alpha rollout.\n",
        )
        .page(
            "Personal/Groceries.md",
            "g",
            "Groceries",
            2,
            "Milk, eggs.\n",
        )
    }

    fn grant(&self, scope: Option<&[&str]>) -> &Self {
        self.write_access(json!({
            "enabled": true,
            "notesDir": self.notes().to_string_lossy(),
            "allowedContexts": scope,
        }))
    }

    fn grant_write(&self, scope: Option<&[&str]>) -> &Self {
        self.write_access(json!({
            "enabled": true,
            "mode": "write",
            "notesDir": self.notes().to_string_lossy(),
            "allowedContexts": scope,
        }))
    }

    fn revoke(&self) -> &Self {
        self.write_access(json!({
            "enabled": false,
            "notesDir": self.notes().to_string_lossy(),
        }))
    }

    fn write_access(&self, body: Value) -> &Self {
        let dir = self.config_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("mcp-access.json"),
            serde_json::to_string_pretty(&body).unwrap(),
        )
        .unwrap();
        self
    }

    fn activity(&self) -> Vec<Value> {
        std::fs::read_to_string(self.config_dir().join("mcp-log.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("a JSON line"))
            .collect()
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_set-mcp"));
        let home = self.home();
        std::fs::create_dir_all(&home).unwrap();
        cmd.env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("APPDATA", home.join("AppData").join("Roaming"))
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env_remove("SET_NOTES_DIR");
        cmd
    }

    fn transcript(&self, args: &[&str], requests: &[Value]) -> Finished {
        let mut child = self
            .command()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("set-mcp to start");
        {
            let mut stdin = child.stdin.take().expect("a stdin pipe");
            for request in requests {
                writeln!(stdin, "{request}").expect("to write a request");
            }
        }
        let output = child.wait_with_output().expect("the server to exit");
        Finished {
            status: output.status,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    fn run(&self, args: &[&str]) -> Finished {
        let output = self
            .command()
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("set-mcp to start");
        Finished {
            status: output.status,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    fn connect(&self, args: &[&str]) -> Client {
        self.connect_with(args, &[])
    }

    fn connect_with(&self, args: &[&str], env: &[(&str, &str)]) -> Client {
        let mut cmd = self.command();
        cmd.args(args);
        for (key, value) in env {
            cmd.env(key, value);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("set-mcp to start");
        let stdin = child.stdin.take().expect("a stdin pipe");
        let stdout = child.stdout.take().expect("a stdout pipe");

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if tx.send(line).is_err() {
                    return;
                }
            }
        });

        Client {
            child,
            stdin: Some(stdin),
            lines: rx,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const APP_DIR: &str = "net.rootstring.set";

struct Finished {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

struct Client {
    child: Child,

    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
}

impl Client {
    fn send(&mut self, message: Value) -> &mut Self {
        self.send_raw(&message.to_string())
    }

    fn send_raw(&mut self, line: &str) -> &mut Self {
        let stdin = self.stdin.as_mut().expect("an open pipe");
        writeln!(stdin, "{line}").expect("to write a request");
        stdin.flush().expect("to flush a request");
        self
    }

    fn recv(&mut self) -> Value {
        match self.lines.recv_timeout(REPLY_TIMEOUT) {
            Ok(line) => serde_json::from_str(&line)
                .unwrap_or_else(|e| panic!("reply was not JSON ({e}): {line:?}")),
            Err(RecvTimeoutError::Timeout) => {
                panic!("no reply within {REPLY_TIMEOUT:?}: an unflushed write looks like this")
            }
            Err(RecvTimeoutError::Disconnected) => panic!("the server closed its output"),
        }
    }

    fn request(&mut self, id: u32, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let reply = self.recv();
        assert_eq!(reply["id"], json!(id), "reply landed against the wrong id");
        assert_eq!(reply["jsonrpc"], "2.0");
        reply
    }

    fn initialize(&mut self) -> Value {
        let reply = self.request(
            1,
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "0"},
            }),
        );
        self.send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        reply
    }

    fn tool(&mut self, id: u32, name: &str, args: Value) -> (String, bool) {
        let reply = self.request(id, "tools/call", json!({"name": name, "arguments": args}));
        let result = &reply["result"];
        let text = result["content"][0]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("no text content in {result}"))
            .to_owned();
        (text, result["isError"].as_bool().unwrap_or(false))
    }

    fn close(mut self) -> ExitStatus {
        self.stdin.take();
        self.child.wait().expect("the server to exit")
    }
}

#[test]
fn a_whole_session_over_the_pipes() {
    let f = Fixture::new();
    f.seed().grant(None);
    let mut client = f.connect(&[]);

    let hello = client.initialize();
    assert_eq!(hello["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(hello["result"]["serverInfo"]["name"], "set");
    assert!(hello["result"]["capabilities"]["tools"].is_object());

    let tools = client.request(2, "tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("a tools array")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["search_pages", "list_contexts", "list_pages", "get_page"]
    );

    let (hits, is_error) = client.tool(3, "search_pages", json!({"query": "rollout"}));
    assert!(!is_error, "{hits}");
    assert!(hits.contains("[id: a]"), "{hits}");
    assert!(hits.contains("[id: b]"), "{hits}");
    assert!(!hits.contains("Groceries"), "{hits}");

    let (page, is_error) = client.tool(4, "get_page", json!({"id": "a"}));
    assert!(!is_error, "{page}");
    assert!(page.contains("The alpha rollout plan."), "{page}");
    assert!(page.contains("Path: Work / Projects"), "{page}");

    let (contexts, is_error) = client.tool(5, "list_contexts", json!({}));
    assert!(!is_error, "{contexts}");
    assert!(contexts.contains("Work  (3 pages)"), "{contexts}");
    assert!(contexts.contains("Personal  (1 page)"), "{contexts}");

    let (narrowed, is_error) = client.tool(6, "list_pages", json!({"context": "Personal"}));
    assert!(!is_error, "{narrowed}");
    assert!(narrowed.contains("Personal / Groceries"), "{narrowed}");
    assert!(!narrowed.contains("Project Alpha"), "{narrowed}");

    assert!(client.close().success());
}

#[test]
fn every_reply_is_one_line_and_nothing_else_is_written() {
    let f = Fixture::new();
    f.seed().grant(None);
    let run = f.transcript(
        &[],
        &[
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": "2025-06-18", "capabilities": {}}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                   "params": {"name": "search_pages", "arguments": {"query": "rollout"}}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                   "params": {"name": "list_pages", "arguments": {}}}),
        ],
    );
    assert!(run.status.success(), "{}", run.stderr);

    let stdout = run.stdout;
    assert!(stdout.ends_with('\n'), "no trailing newline: {stdout:?}");
    let lines: Vec<&str> = stdout.lines().collect();

    assert_eq!(lines.len(), 3, "{lines:#?}");
    for line in &lines {
        let value: Value = serde_json::from_str(line).expect("each line is one message");
        assert_eq!(value["jsonrpc"], "2.0");
    }
}

#[test]
fn a_pipe_that_closes_with_nothing_on_it_is_a_clean_exit() {
    let f = Fixture::new();
    f.seed().grant(None);
    assert!(f.connect(&[]).close().success());
}

#[test]
fn blank_lines_and_malformed_lines_do_not_end_the_session() {
    let f = Fixture::new();
    f.seed().grant(None);
    let mut client = f.connect(&[]);
    client.initialize();

    client.send_raw("");
    client.send_raw("   ");
    client.send_raw("not json at all");
    let broken = client.recv();
    assert_eq!(broken["error"]["code"], -32700);

    let (text, _) = client.tool(2, "get_page", json!({"id": "g"}));
    assert!(text.contains("Milk, eggs."), "{text}");
    assert!(client.close().success());
}

#[test]
fn access_off_refuses_to_start_and_says_where_the_switch_is() {
    let f = Fixture::new();
    f.seed().revoke();
    let run = f.run(&[]);

    assert!(!run.status.success(), "a refused server must not exit 0");

    assert!(
        run.stderr.contains("Settings") && run.stderr.contains("Agent access"),
        "{}",
        run.stderr
    );
    assert!(
        run.stderr.contains("mcp-access.json"),
        "the message should name the file it read: {}",
        run.stderr
    );

    assert_eq!(run.stdout, "");

    let log = f.activity();
    assert_eq!(log.len(), 1, "{log:#?}");
    assert_eq!(log[0]["tool"], "denied");
}

#[test]
fn a_missing_access_file_is_off() {
    let f = Fixture::new();
    f.seed();
    let run = f.run(&[]);
    assert!(!run.status.success());
    assert_eq!(run.stdout, "");
}

#[test]
fn a_malformed_access_file_is_off() {
    let f = Fixture::new();
    f.seed();
    std::fs::create_dir_all(f.config_dir()).unwrap();
    std::fs::write(f.config_dir().join("mcp-access.json"), "{ enabled: yes").unwrap();
    let run = f.run(&[]);
    assert!(!run.status.success());
    assert_eq!(run.stdout, "");
}

#[test]
fn the_scope_in_the_access_file_is_what_the_binary_enforces() {
    let f = Fixture::new();
    f.seed().grant(Some(&["Work"]));
    let mut client = f.connect(&[]);
    client.initialize();

    let (listed, _) = client.tool(2, "list_pages", json!({}));
    assert!(listed.contains("Project Alpha"), "{listed}");
    assert!(listed.contains("Project Beta"), "{listed}");
    assert!(!listed.contains("Groceries"), "{listed}");

    let (contexts, _) = client.tool(3, "list_contexts", json!({}));
    assert!(contexts.contains("Work"), "{contexts}");
    assert!(!contexts.contains("Personal"), "{contexts}");

    let (refused, is_error) = client.tool(4, "get_page", json!({"id": "g"}));
    assert!(is_error, "{refused}");
    assert!(
        refused.contains("in a context outside the ones"),
        "{refused}"
    );

    assert!(client.close().success());
}

#[test]
fn a_grant_scoped_to_nothing_says_so_rather_than_faking_an_empty_notes_folder() {
    let f = Fixture::new();
    f.seed().grant(Some(&[]));
    let mut client = f.connect(&[]);
    client.initialize();
    let (text, _) = client.tool(2, "list_pages", json!({}));
    assert!(text.contains("no contexts are in scope"), "{text}");
    assert!(client.close().success());
}

#[test]
fn the_recorded_folder_is_what_a_client_with_no_arguments_gets() {
    let f = Fixture::new();
    f.seed().grant(None);
    let mut client = f.connect(&[]);
    client.initialize();
    let (text, _) = client.tool(2, "get_page", json!({"id": "b"}));
    assert!(text.contains("Beta is blocked"), "{text}");
    assert!(client.close().success());
}

#[test]
fn the_flag_beats_the_environment_which_beats_the_recorded_folder() {
    let f = Fixture::new();

    f.seed().grant(None);
    let env_dir = f.dir.join("from-env");
    let flag_dir = f.dir.join("from-flag");
    for (dir, id, title) in [
        (&env_dir, "env", "Env Page"),
        (&flag_dir, "flag", "Flag Page"),
    ] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("Page.md"),
            format!(
                "---\nid: {id:?}\ntitle: {title:?}\norder: 0\ncreatedAt: 1\nupdatedAt: 2\n---\n\nbody\n"
            ),
        )
        .unwrap();
    }
    let env = [("SET_NOTES_DIR", env_dir.to_str().unwrap())];

    let mut client = f.connect_with(&[], &env);
    client.initialize();
    let (text, _) = client.tool(2, "list_pages", json!({}));
    assert!(text.contains("Env Page"), "{text}");
    assert!(client.close().success());

    for args in [
        vec!["--notes-dir".to_owned(), flag_dir.display().to_string()],
        vec![format!("--notes-dir={}", flag_dir.display())],
    ] {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut client = f.connect_with(&args, &env);
        client.initialize();
        let (text, _) = client.tool(2, "list_pages", json!({}));
        assert!(text.contains("Flag Page"), "{args:?}: {text}");
        assert!(client.close().success());
    }
}

#[test]
fn a_missing_notes_folder_warns_but_still_serves() {
    let f = Fixture::new();
    f.grant(None);
    let mut client = f.connect(&[]);
    client.initialize();
    let (text, is_error) = client.tool(2, "list_pages", json!({}));
    assert!(!is_error, "{text}");
    assert!(text.contains("no pages"), "{text}");
    assert!(client.close().success());

    let run = f.transcript(&[], &[]);
    assert!(run.stderr.contains("does not exist yet"), "{}", run.stderr);
    assert_eq!(run.stdout, "");
}

#[test]
fn help_exits_zero_and_names_the_tools() {
    let f = Fixture::new();
    let run = f.run(&["--help"]);
    assert!(run.status.success(), "{}", run.stderr);
    for tool in ["list_pages", "search_pages", "get_page"] {
        assert!(run.stdout.contains(tool), "{}", run.stdout);
    }

    assert!(run.stdout.contains("--notes-dir"), "{}", run.stdout);
}

#[test]
fn a_bad_command_line_is_refused_rather_than_guessed_at() {
    let f = Fixture::new();
    f.seed().grant(None);
    for args in [vec!["--notes-dir"], vec!["--wat"], vec!["/some/path"]] {
        let run = f.run(&args);
        assert!(!run.status.success(), "{args:?} was accepted");
        assert_eq!(run.stdout, "", "{args:?}");
        assert!(run.stderr.contains("set-mcp:"), "{args:?}: {}", run.stderr);
    }
}

#[test]
fn a_read_only_grant_neither_lists_nor_accepts_the_create_tools() {
    let f = Fixture::new();
    f.seed().grant(None);
    let mut client = f.connect(&[]);
    client.initialize();

    let tools = client.request(2, "tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("a tools array")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["search_pages", "list_contexts", "list_pages", "get_page"]
    );

    let (refused, is_error) = client.tool(3, "create_page", json!({"title": "Nope"}));
    assert!(is_error, "{refused}");
    assert!(refused.contains("write access"), "{refused}");
    assert!(client.close().success());

    assert!(!f.notes().join("Work/Nope.md").exists());
}

#[test]
fn write_mode_creates_a_page_the_next_session_can_read() {
    let f = Fixture::new();
    f.seed().grant_write(None);
    let mut client = f.connect(&[]);
    client.initialize();

    let tools = client.request(2, "tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("a tools array")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "search_pages",
            "list_contexts",
            "list_pages",
            "get_page",
            "create_page",
            "create_context"
        ]
    );

    let (made, is_error) = client.tool(
        3,
        "create_page",
        json!({"title": "What the user prefers", "text": "Prefers dark mode.",
               "context": "Personal"}),
    );
    assert!(!is_error, "{made}");
    assert!(made.contains("Personal / What the user prefers"), "{made}");
    assert!(client.close().success());

    let path = f.notes().join("Personal/What-the-user-prefers.md");
    let text = std::fs::read_to_string(&path).expect("the page on disk");
    assert!(text.starts_with("---\nid: \""), "{text}");
    assert!(text.contains("title: \"What the user prefers\""), "{text}");
    assert!(text.ends_with("Prefers dark mode.\n"), "{text}");

    let mut later = f.connect(&[]);
    later.initialize();
    let (found, _) = later.tool(2, "search_pages", json!({"query": "dark mode"}));
    assert!(found.contains("What the user prefers"), "{found}");
    assert!(later.close().success());
}

#[test]
fn write_mode_creates_a_context_and_refuses_a_second_of_the_same_name() {
    let f = Fixture::new();
    f.seed().grant_write(None);
    let mut client = f.connect(&[]);
    client.initialize();

    let (made, is_error) = client.tool(2, "create_context", json!({"name": "Memories"}));
    assert!(!is_error, "{made}");
    assert!(f.notes().join("Memories").is_dir());

    let (again, is_error) = client.tool(3, "create_context", json!({"name": "Memories"}));
    assert!(is_error, "{again}");
    assert!(again.contains("already exists"), "{again}");
    assert!(client.close().success());
}

#[test]
fn turning_write_mode_off_stops_the_client_already_configured() {
    let f = Fixture::new();
    f.seed().grant_write(None);
    let mut client = f.connect(&[]);
    client.initialize();
    let (made, is_error) = client.tool(
        2,
        "create_page",
        json!({"title": "First", "context": "Work"}),
    );
    assert!(!is_error, "{made}");
    assert!(client.close().success());

    f.grant(None);
    let mut after = f.connect(&[]);
    after.initialize();
    let (refused, is_error) = after.tool(
        2,
        "create_page",
        json!({"title": "Second", "context": "Work"}),
    );
    assert!(is_error, "{refused}");
    assert!(after.close().success());

    assert!(f.notes().join("Work/First.md").exists());
    assert!(!f.notes().join("Work/Second.md").exists());
}

#[test]
fn what_a_client_asked_is_written_to_the_activity_log() {
    let f = Fixture::new();
    f.seed().grant(None);
    let mut client = f.connect(&[]);
    client.initialize();
    client.tool(2, "search_pages", json!({"query": "rollout"}));
    client.tool(3, "get_page", json!({"id": "a"}));
    client.tool(4, "list_pages", json!({}));
    assert!(client.close().success());

    let log = f.activity();
    let seen: HashMap<&str, &Value> = log
        .iter()
        .map(|e| (e["tool"].as_str().unwrap(), e))
        .collect();
    assert_eq!(log.len(), 3, "{log:#?}");

    assert_eq!(seen["search_pages"]["detail"], "rollout");
    assert_eq!(seen["search_pages"]["results"], 2);

    assert_eq!(
        seen["get_page"]["detail"],
        "Work / Projects / Project Alpha"
    );
    assert_eq!(seen["get_page"]["results"], 1);
    assert_eq!(seen["list_pages"]["results"], 4);
    for entry in &log {
        assert!(entry["at"].as_u64().unwrap_or(0) > 0, "{entry}");
    }
}

#[test]
fn what_a_client_created_is_written_to_the_activity_log_too() {
    let f = Fixture::new();
    f.seed().grant_write(None);
    let mut client = f.connect(&[]);
    client.initialize();
    client.tool(2, "create_context", json!({"name": "Memories"}));
    client.tool(
        3,
        "create_page",
        json!({"title": "Standing order", "context": "Memories"}),
    );
    assert!(client.close().success());

    let log = f.activity();
    assert_eq!(log.len(), 2, "{log:#?}");
    assert_eq!(log[0]["tool"], "create_context");
    assert_eq!(log[0]["detail"], "Memories");
    assert_eq!(log[1]["tool"], "create_page");

    assert_eq!(log[1]["detail"], "Memories / Standing order");
}

#[test]
fn the_handshake_leaves_no_trace_in_the_log() {
    let f = Fixture::new();
    f.seed().grant(None);
    let mut client = f.connect(&[]);
    client.initialize();
    client.request(2, "tools/list", json!({}));
    client.request(3, "ping", json!({}));
    assert!(client.close().success());
    assert_eq!(f.activity(), Vec::<Value>::new());
}

#[test]
fn the_log_lives_beside_the_switch_and_never_in_the_notes() {
    let f = Fixture::new();
    f.seed().grant(None);
    let mut client = f.connect(&[]);
    client.initialize();
    client.tool(2, "search_pages", json!({"query": "rollout"}));
    assert!(client.close().success());

    assert!(f.config_dir().join("mcp-log.jsonl").is_file());
    assert!(!contains_any_file_named(&f.notes(), "mcp-log.jsonl"));
    assert!(!contains_any_file_named(&f.notes(), "mcp-access.json"));
}

fn contains_any_file_named(dir: &Path, name: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        if path.is_dir() {
            contains_any_file_named(&path, name)
        } else {
            path.file_name().is_some_and(|f| f == name)
        }
    })
}
