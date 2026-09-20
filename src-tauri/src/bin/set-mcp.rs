use std::io::{self, BufReader};
use std::path::PathBuf;
use std::process::ExitCode;

use set_lib::mcp::{access, log, Journal, Server};

struct FileJournal;

impl Journal for FileJournal {
    fn record(&self, tool: &str, detail: &str, results: usize) {
        log::append(&log::Entry::new(tool, detail, results));
    }
}

fn main() -> ExitCode {
    let explicit_dir = match parse_args() {
        Ok(Args::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(Args::Serve(dir)) => dir,
        Err(message) => {
            eprintln!("set-mcp: {message}");
            return ExitCode::FAILURE;
        }
    };

    let access = access::read();
    if !access.enabled {
        log::append(&log::Entry::new(
            "denied",
            "a client tried to connect while agent access was off",
            0,
        ));

        eprintln!(
            "set-mcp: access to your notes is off. Turn it on in Set under \
Settings → Agent access.{}",
            access::access_file()
                .map(|p| format!("\nset-mcp: (the switch is recorded in {})", p.display()))
                .unwrap_or_default()
        );
        return ExitCode::FAILURE;
    }

    let root = match notes_dir(explicit_dir, &access) {
        Ok(root) => root,
        Err(message) => {
            eprintln!("set-mcp: {message}");
            return ExitCode::FAILURE;
        }
    };

    if !root.is_dir() {
        eprintln!(
            "set-mcp: notes folder {} does not exist yet; serving nothing.",
            root.display()
        );
    }

    let server = Server::new(root)
        .with_scope(access.allowed_contexts.clone())
        .with_write(access.mode.writable())
        .with_journal(Box::new(FileJournal));

    match server.serve(BufReader::new(io::stdin()), io::stdout()) {
        Ok(()) => ExitCode::SUCCESS,

        Err(err) if err.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("set-mcp: {err}");
            ExitCode::FAILURE
        }
    }
}

enum Args {
    Help,

    Serve(Option<PathBuf>),
}

fn parse_args() -> Result<Args, String> {
    let mut args = std::env::args().skip(1);
    let Some(arg) = args.next() else {
        return Ok(Args::Serve(None));
    };
    match arg.as_str() {
        "--help" | "-h" => Ok(Args::Help),
        "--notes-dir" => args
            .next()
            .map(|path| Args::Serve(Some(PathBuf::from(path))))
            .ok_or_else(|| format!("--notes-dir needs a path\n\n{USAGE}")),
        other => match other.strip_prefix("--notes-dir=") {
            Some(path) => Ok(Args::Serve(Some(PathBuf::from(path)))),
            None => Err(format!("unknown argument {other:?}\n\n{USAGE}")),
        },
    }
}

fn notes_dir(explicit: Option<PathBuf>, access: &access::Access) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        return Ok(path);
    }
    if let Some(path) = std::env::var_os("SET_NOTES_DIR") {
        return Ok(PathBuf::from(path));
    }

    if let Some(path) = access.notes_dir.clone() {
        return Ok(path);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("no --notes-dir given and no home directory to default from")?;
    Ok(PathBuf::from(home).join("Documents").join("Set"))
}

const USAGE: &str = "\
set-mcp: MCP server over a Set notes folder (stdio transport).

Usage: set-mcp [--notes-dir <path>]

  --notes-dir <path>  The notes folder to serve. Defaults to $SET_NOTES_DIR,
                      then to the folder Set recorded when you granted access,
                      then to ~/Documents/Set.

Access is off until you turn it on in Set under Settings -> Agent access.

Speaks newline-delimited JSON-RPC on stdin/stdout; it is meant to be spawned by
an MCP client, not run by hand.

Tools: list_contexts, list_pages, search_pages, get_page, plus create_page and
create_context when agent access is set to allow new pages. A page created under a
parent is listed at the end of that parent; nothing here can otherwise edit or delete
a page that already exists.";
