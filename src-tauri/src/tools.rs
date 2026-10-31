use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;

/// Apps launched from Finder get a bare PATH, so add the usual places TeX and friends live.
pub fn search_path() -> OsString {
    let mut dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|p| env::split_paths(&p).collect())
        .unwrap_or_default();
    let mut extra = vec![
        PathBuf::from("/Library/TeX/texbin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        extra.push(home.join(".cargo/bin"));
        extra.push(home.join(".local/bin"));
    }
    for dir in extra {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    env::join_paths(dirs).unwrap_or_default()
}

pub fn which(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    env::split_paths(&search_path())
        .map(|dir| dir.join(&exe))
        .find(|p| p.is_file())
}

/// A `Command` for a tool found on the extended search path.
pub fn command(name: &str) -> Result<Command, String> {
    let path = which(name).ok_or_else(|| format!("`{name}` was not found on PATH"))?;
    let mut cmd = Command::new(path);
    cmd.env("PATH", search_path());
    Ok(cmd)
}
