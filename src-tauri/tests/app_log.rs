//! A process of its own, so it can be given its own `HOME`; `log::emit` refuses to write in unit
//! tests.

use std::path::PathBuf;

#[test]
fn a_line_lands_where_the_os_keeps_logs() {
    let home = std::env::temp_dir().join(format!("set-app-log-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    // The one test in this binary, so nothing else is racing the variable.
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("XDG_STATE_HOME", home.join(".local").join("state"));
    std::env::set_var("LOCALAPPDATA", home.join("AppData").join("Local"));

    let path = set_lib::log::log_file().expect("a log path");
    assert!(
        path.starts_with(&home),
        "{path:?} isn't under the home we set"
    );
    assert!(!path.exists(), "the log existed before anything was logged");

    set_lib::log::info("test.wrote")
        .field("path", PathBuf::from("/Users/x/My Notes").display())
        .emit();

    let written = std::fs::read_to_string(&path).expect("the log file");
    assert!(
        written.ends_with(" INFO  test.wrote path=\"/Users/x/My Notes\"\n"),
        "{written:?}"
    );

    std::fs::remove_dir_all(&home).ok();
}
