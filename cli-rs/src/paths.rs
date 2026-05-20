//! Project-relative path helpers shared across commands.
//!
//! Mirrors the rules from `webapp/lib/paths.ts`: every consumer must go
//! through `resolve_workspace` to keep file IO inside the wiki / raw /
//! sessions roots and away from accidental traversal.

use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Result};

/// Workspace roots the CLI is allowed to touch. Currently only `Raw` is
/// exercised by the `raw add/remove/list` commands; the enum exists so we
/// can extend safe resolution to other roots without changing call sites.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Workspace {
    Raw,
}

impl Workspace {
    pub fn dir_name(self) -> &'static str {
        match self {
            Workspace::Raw => "raw",
        }
    }
}

/// Resolve a workspace-relative path against the project root, refusing
/// anything that escapes the workspace via `..` or absolute traversal.
pub fn resolve_workspace(
    project_root: &Path,
    workspace: Workspace,
    relative: &str,
) -> Result<PathBuf> {
    let mut path = PathBuf::from(workspace.dir_name());
    for component in Path::new(relative).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !path.pop() || path.as_os_str() == "" {
                    return Err(anyhow!(
                        "path escapes workspace '{}': {relative}",
                        workspace.dir_name()
                    ));
                }
            }
            Component::Normal(part) => path.push(part),
            Component::RootDir | Component::Prefix(_) => {
                return Err(anyhow!("workspace path must be relative: {relative}"));
            }
        }
    }

    if !path.starts_with(workspace.dir_name()) {
        return Err(anyhow!(
            "path escapes workspace '{}': {relative}",
            workspace.dir_name()
        ));
    }
    Ok(project_root.join(path))
}

/// Convert an arbitrary user-supplied path to a destination key under the
/// raw/ workspace. Absolute paths or paths outside cwd fall back to the
/// file's basename.
pub fn raw_destination(target: &Path) -> String {
    target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "untitled".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn rejects_parent_traversal() {
        let root = PathBuf::from("/clio");
        let err = resolve_workspace(&root, Workspace::Raw, "../etc/passwd").unwrap_err();
        assert!(err.to_string().contains("escapes workspace"));
    }

    #[test]
    fn accepts_nested_subpath() {
        let root = PathBuf::from("/clio");
        let resolved = resolve_workspace(&root, Workspace::Raw, "a/b/c.md").unwrap();
        assert_eq!(resolved, PathBuf::from("/clio/raw/a/b/c.md"));
    }

    #[test]
    fn rejects_absolute_relative() {
        let root = PathBuf::from("/clio");
        let err = resolve_workspace(&root, Workspace::Raw, "/etc/passwd").unwrap_err();
        assert!(err.to_string().contains("must be relative"));
    }

    #[test]
    fn collapses_cur_dir() {
        let root = PathBuf::from("/clio");
        let resolved = resolve_workspace(&root, Workspace::Raw, "./pages/index.md").unwrap();
        assert_eq!(resolved, PathBuf::from("/clio/raw/pages/index.md"));
    }

    #[test]
    fn raw_destination_uses_basename() {
        assert_eq!(raw_destination(Path::new("/tmp/foo/bar.md")), "bar.md");
        assert_eq!(raw_destination(Path::new("baz.pdf")), "baz.pdf");
    }
}
