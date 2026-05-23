//! `clio raw …` — manage the `raw/` source-material tree directly on disk.
//!
//! These commands intentionally bypass the webapp HTTP API because:
//!
//!   1. They are pure file moves; no LLM work is involved.
//!   2. Most users will run `clio raw add` from a different shell than the
//!      one hosting the webapp, so requiring the server to be up would be a
//!      bad UX trade.
//!
//! We still respect the AGENTS.md / CLAUDE.md hard rules:
//!
//!   * `add` writes inside `raw/` only (resolved via `paths::resolve_workspace`).
//!     If the destination already exists, the previous entry is moved to
//!     `raw/.trash/<ISO-ts>_<basename>` before the new bytes land. That
//!     matches the "update via /preprocess" backup contract.
//!   * `remove` never deletes; it always moves to `raw/.trash/`.
//!   * `list` is a thin walk over `raw/`, skipping `raw/.trash/` and dot
//!     entries (`.gitkeep` excluded).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use clap::{Args, Subcommand};
use console::style;
use tokio::fs;
use walkdir::WalkDir;

use crate::config::Context as Ctx;
use crate::paths::{raw_destination, resolve_workspace, Workspace};

#[derive(Debug, Subcommand)]
pub enum RawCmd {
    /// Copy or symlink a file or directory into raw/. Existing entries are
    /// replaced and moved to raw/.trash/.
    Add(AddArgs),
    /// Soft-delete a file inside raw/ by moving it to raw/.trash/.
    Remove(RemoveArgs),
    /// List files currently under raw/.
    List(ListArgs),
}

#[derive(Debug, Args)]
pub struct AddArgs {
    /// Source path(s) on the local filesystem.
    #[arg(required = true, value_name = "PATH")]
    pub sources: Vec<PathBuf>,

    /// Destination path under raw/. Defaults to the basename of each source.
    /// Only meaningful with a single source.
    #[arg(long)]
    pub dest: Option<String>,

    /// Print actions without touching the filesystem.
    #[arg(long)]
    pub dry_run: bool,

    /// Create a symbolic link in raw/ instead of copying bytes. Directory
    /// sources are linked as directories instead of being expanded.
    #[arg(long)]
    pub symlink: bool,
}

#[derive(Debug, Args)]
pub struct RemoveArgs {
    /// Workspace-relative path inside raw/.
    #[arg(required = true, value_name = "RAW_PATH")]
    pub paths: Vec<String>,

    /// Print actions without touching the filesystem.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
pub struct ListArgs {
    /// Workspace-relative subdirectory under raw/. Default lists the root.
    #[arg(value_name = "RAW_PATH")]
    pub path: Option<String>,
}

pub async fn run(ctx: &Ctx, cmd: RawCmd) -> Result<u8> {
    match cmd {
        RawCmd::Add(args) => run_add(ctx, args).await,
        RawCmd::Remove(args) => run_remove(ctx, args).await,
        RawCmd::List(args) => run_list(ctx, args).await,
    }
}

async fn run_add(ctx: &Ctx, args: AddArgs) -> Result<u8> {
    if args.dest.is_some() && args.sources.len() > 1 {
        bail!("--dest can only be used with a single source path");
    }

    let mut added = 0u32;
    let mut updated = 0u32;

    for src in &args.sources {
        if !src.exists() {
            bail!("source does not exist: {}", src.display());
        }
        let metadata = fs::metadata(src)
            .await
            .with_context(|| format!("failed to stat {}", src.display()))?;
        if args.symlink {
            let dest = args.dest.clone().unwrap_or_else(|| raw_destination(src));
            add_one(
                ctx,
                src,
                &dest,
                AddMode::Symlink {
                    source_is_dir: metadata.is_dir(),
                },
                args.dry_run,
                &mut added,
                &mut updated,
            )
            .await?;
        } else if metadata.is_dir() {
            walk_and_add(
                ctx,
                src,
                args.dest.as_deref(),
                args.dry_run,
                &mut added,
                &mut updated,
            )
            .await?;
        } else {
            let dest = args.dest.clone().unwrap_or_else(|| raw_destination(src));
            add_one(
                ctx,
                src,
                &dest,
                AddMode::Copy,
                args.dry_run,
                &mut added,
                &mut updated,
            )
            .await?;
        }
    }

    if args.dry_run {
        println!(
            "{} would add {} new, update {} existing",
            style("dry-run:").yellow(),
            added,
            updated
        );
    } else {
        println!(
            "{} added {} new, updated {} existing",
            style("raw:").green(),
            added,
            updated
        );
    }
    Ok(0)
}

#[derive(Clone, Copy, Debug)]
enum AddMode {
    Copy,
    Symlink { source_is_dir: bool },
}

async fn walk_and_add(
    ctx: &Ctx,
    src_root: &Path,
    dest_prefix: Option<&str>,
    dry_run: bool,
    added: &mut u32,
    updated: &mut u32,
) -> Result<()> {
    let prefix = dest_prefix
        .map(str::to_string)
        .unwrap_or_else(|| raw_destination(src_root));
    let walker = WalkDir::new(src_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Skip dotfiles to mirror the explorer view's defaults.
            e.file_name()
                .to_str()
                .map(|s| !s.starts_with('.'))
                .unwrap_or(true)
        });
    for entry in walker {
        let entry = entry.with_context(|| format!("walking {}", src_root.display()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(src_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| entry.path().to_path_buf());
        let dest = if rel.as_os_str().is_empty() {
            prefix.clone()
        } else {
            format!("{}/{}", prefix.trim_end_matches('/'), path_key(&rel))
        };
        add_one(
            ctx,
            entry.path(),
            &dest,
            AddMode::Copy,
            dry_run,
            added,
            updated,
        )
        .await?;
    }
    Ok(())
}

async fn add_one(
    ctx: &Ctx,
    src: &Path,
    dest_rel: &str,
    mode: AddMode,
    dry_run: bool,
    added: &mut u32,
    updated: &mut u32,
) -> Result<()> {
    let dest_abs = resolve_workspace(&ctx.project_root, Workspace::Raw, dest_rel)?;
    let existing = fs::symlink_metadata(&dest_abs).await.ok();
    let exists = existing.is_some();
    let verb = match mode {
        AddMode::Copy => "add",
        AddMode::Symlink { .. } => "link",
    };

    if dry_run {
        if exists {
            *updated += 1;
            println!(
                "  {} {} → raw/{} (replace)",
                style("update").yellow(),
                src.display(),
                dest_rel
            );
        } else {
            *added += 1;
            println!(
                "  {}  {} → raw/{}",
                style(verb).green(),
                src.display(),
                dest_rel
            );
        }
        return Ok(());
    }

    if let Some(parent) = dest_abs.parent() {
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create parent directory {}", parent.display()))?;
    }

    if exists {
        move_to_trash(ctx, &dest_abs).await?;
        *updated += 1;
    } else {
        *added += 1;
    }

    match mode {
        AddMode::Copy => {
            fs::copy(src, &dest_abs).await.with_context(|| {
                format!("failed to copy {} → {}", src.display(), dest_abs.display())
            })?;
        }
        AddMode::Symlink { source_is_dir } => {
            let target = fs::canonicalize(src)
                .await
                .with_context(|| format!("failed to resolve {}", src.display()))?;
            create_symlink(&target, &dest_abs, source_is_dir).with_context(|| {
                format!(
                    "failed to symlink {} → {}",
                    target.display(),
                    dest_abs.display()
                )
            })?;
        }
    }
    println!(
        "  {} {} → raw/{}",
        style("ok").green(),
        src.display(),
        dest_rel
    );
    Ok(())
}

async fn run_remove(ctx: &Ctx, args: RemoveArgs) -> Result<u8> {
    let mut removed = 0u32;
    for rel in &args.paths {
        let abs = resolve_workspace(&ctx.project_root, Workspace::Raw, rel)?;
        if fs::symlink_metadata(&abs).await.is_err() {
            eprintln!("{} not found: raw/{rel}", style("warn:").yellow());
            continue;
        }
        if args.dry_run {
            println!(
                "{} would move raw/{} → raw/.trash/",
                style("dry-run:").yellow(),
                rel
            );
        } else {
            move_to_trash(ctx, &abs).await?;
            println!("{} raw/{} → raw/.trash/", style("removed:").green(), rel);
        }
        removed += 1;
    }
    if args.dry_run {
        println!(
            "{} would remove {} entries",
            style("dry-run:").yellow(),
            removed
        );
    }
    Ok(0)
}

async fn run_list(ctx: &Ctx, args: ListArgs) -> Result<u8> {
    let base = match args.path.as_deref() {
        Some(rel) => resolve_workspace(&ctx.project_root, Workspace::Raw, rel)?,
        None => ctx.project_root.join("raw"),
    };
    if fs::metadata(&base).await.is_err() {
        bail!("raw/ path does not exist: {}", base.display());
    }
    let mut count = 0usize;
    for entry in WalkDir::new(&base)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(name == ".trash" || name == ".gitkeep")
        })
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                eprintln!("{} {err}", style("warn:").yellow());
                continue;
            }
        };
        if !(entry.file_type().is_file() || entry.path_is_symlink()) {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&ctx.project_root)
            .map(path_key)
            .unwrap_or_else(|_| entry.path().to_string_lossy().into_owned());
        println!("{rel}");
        count += 1;
    }
    eprintln!("{} {} files", style("total:").dim(), count);
    Ok(0)
}

async fn move_to_trash(ctx: &Ctx, source: &Path) -> Result<()> {
    let trash_dir = ctx.project_root.join("raw").join(".trash");
    fs::create_dir_all(&trash_dir)
        .await
        .with_context(|| format!("failed to create {}", trash_dir.display()))?;
    let basename = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "untitled".to_string());
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let target = trash_dir.join(format!("{stamp}_{basename}"));
    if fs::symlink_metadata(&target).await.is_ok() {
        return Err(anyhow!(
            "trash backup collision: {} already exists",
            target.display()
        ));
    }
    fs::rename(source, &target)
        .await
        .with_context(|| format!("failed to move {} → {}", source.display(), target.display()))?;
    Ok(())
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path, _target_is_dir: bool) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_symlink(target: &Path, link: &Path, target_is_dir: bool) -> std::io::Result<()> {
    if target_is_dir {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

fn path_key(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}
