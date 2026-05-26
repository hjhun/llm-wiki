//! Resolve the active CLIO project root and load enough of
//! `config/local.json` to talk to the webapp.
//!
//! Lookup order, mirrored from `webapp/lib/paths.ts` and extended for the
//! Rust CLI:
//!   1. Explicit `--home`/`$CLIO_HOME`.
//!   2. Walk up from `cwd` searching for the project markers
//!      (`llm-wiki.md` or `CLAUDE.md`).
//!   3. `$HOME/.clio` if it looks like a CLIO project (the install default).
//!
//! Once the root is known we read `config/default.json` first, overlay
//! `config/local.json` shallowly, and expose only the bits the CLI needs:
//! `server.host`, `server.port`, and `auth.cliToken`.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context as _, Result};
use serde::Deserialize;
use tokio::fs;

const PROJECT_MARKERS: &[&str] = &["llm-wiki.md", "CLAUDE.md"];

/// Runtime context passed to every command.
pub struct Context {
    pub project_root: PathBuf,
    pub base_url: String,
    pub server_host: String,
    pub server_port: u16,
    /// `auth.cliToken` value. `None` means we found no token; commands that
    /// require auth surface a friendly error instead of blowing up at the
    /// first 401 response.
    pub token: Option<String>,
}

impl Context {
    pub async fn resolve(
        home_override: Option<PathBuf>,
        base_url_override: Option<String>,
        token_override: Option<String>,
    ) -> Result<Self> {
        let project_root = resolve_project_root(home_override).await?;
        let cfg = load_config(&project_root).await?;
        let base_url = base_url_override.unwrap_or_else(|| build_base_url(&cfg));
        let server_host = configured_server_host(&cfg);
        let server_port = configured_server_port(&cfg);
        let token = token_override.or(cfg.auth.cli_token);
        Ok(Self {
            project_root,
            base_url,
            server_host,
            server_port,
            token,
        })
    }

    pub fn require_token(&self) -> Result<&str> {
        self.token.as_deref().ok_or_else(|| {
            anyhow!(
                "no CLI token configured. Run setup.sh once or set CLIO_TOKEN \
                 (expected in config/local.json -> auth.cliToken)"
            )
        })
    }
}

async fn resolve_project_root(home_override: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(explicit) = home_override {
        let path = canonicalize_or_self(&explicit).await;
        if !looks_like_project(&path).await {
            return Err(anyhow!(
                "{} does not look like a CLIO project (missing {} or {})",
                path.display(),
                PROJECT_MARKERS[0],
                PROJECT_MARKERS[1],
            ));
        }
        return Ok(path);
    }

    let cwd = std::env::current_dir().context("failed to read current directory")?;
    if let Some(project) = find_project_ancestor(&cwd).await {
        return Ok(canonicalize_or_self(&project).await);
    }

    if let Some(home_dir) = dirs::home_dir() {
        let candidate = home_dir.join(".clio");
        if looks_like_project(&candidate).await {
            return Ok(canonicalize_or_self(&candidate).await);
        }
    }

    Err(anyhow!(
        "could not find a CLIO project. Tried $CLIO_HOME, walking up from {}, and ~/.clio.",
        cwd.display(),
    ))
}

async fn find_project_ancestor(cwd: &Path) -> Option<PathBuf> {
    let mut cur = cwd;
    loop {
        if looks_like_project(cur).await {
            return Some(cur.to_path_buf());
        }
        match cur.parent() {
            Some(parent) if parent != cur => cur = parent,
            _ => break,
        }
    }
    None
}

async fn looks_like_project(path: &Path) -> bool {
    for marker in PROJECT_MARKERS {
        if fs::metadata(path.join(marker)).await.is_ok() {
            return true;
        }
    }
    false
}

async fn canonicalize_or_self(path: &Path) -> PathBuf {
    fs::canonicalize(path)
        .await
        .unwrap_or_else(|_| path.to_path_buf())
}

#[derive(Debug, Default, Deserialize)]
struct RawConfig {
    #[serde(default)]
    server: ServerConfig,
    #[serde(default)]
    auth: AuthConfig,
}

#[derive(Debug, Default, Deserialize)]
struct ServerConfig {
    host: Option<String>,
    port: Option<u16>,
}

#[derive(Debug, Default, Deserialize)]
struct AuthConfig {
    #[serde(rename = "cliToken", default)]
    cli_token: Option<String>,
}

async fn load_config(project_root: &Path) -> Result<RawConfig> {
    let default_path = project_root.join("config").join("default.json");
    let local_path = project_root.join("config").join("local.json");

    let mut cfg = read_json(&default_path).await?.unwrap_or_default();
    if let Some(local) = read_json(&local_path).await? {
        if local.server.host.is_some() {
            cfg.server.host = local.server.host;
        }
        if local.server.port.is_some() {
            cfg.server.port = local.server.port;
        }
        if local.auth.cli_token.is_some() {
            cfg.auth.cli_token = local.auth.cli_token;
        }
    }
    Ok(cfg)
}

async fn read_json(path: &Path) -> Result<Option<RawConfig>> {
    match fs::read(path).await {
        Ok(bytes) => {
            let parsed: RawConfig = serde_json::from_slice(&bytes)
                .with_context(|| format!("failed to parse {}", path.display()))?;
            Ok(Some(parsed))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => {
            Err(anyhow::Error::new(err).context(format!("failed to read {}", path.display())))
        }
    }
}

fn build_base_url(cfg: &RawConfig) -> String {
    let host = configured_server_host(cfg);
    // The webapp binds 0.0.0.0 by default. From the local CLI we always
    // dial localhost so the request never traverses the LAN.
    let host = if host == "0.0.0.0" {
        "127.0.0.1"
    } else {
        host.as_str()
    };
    let port = configured_server_port(cfg);
    format!("http://{host}:{port}")
}

fn configured_server_host(cfg: &RawConfig) -> String {
    cfg.server
        .host
        .as_deref()
        .filter(|h| !h.is_empty())
        .unwrap_or("0.0.0.0")
        .to_string()
}

fn configured_server_port(cfg: &RawConfig) -> u16 {
    cfg.server.port.unwrap_or(9091)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_base_url_replaces_wildcard_host() {
        let cfg = RawConfig {
            server: ServerConfig {
                host: Some("0.0.0.0".into()),
                port: Some(7777),
            },
            ..Default::default()
        };
        assert_eq!(build_base_url(&cfg), "http://127.0.0.1:7777");
    }

    #[test]
    fn build_base_url_uses_localhost_default() {
        let cfg = RawConfig::default();
        assert_eq!(build_base_url(&cfg), "http://127.0.0.1:9091");
    }

    #[test]
    fn build_base_url_honours_explicit_host() {
        let cfg = RawConfig {
            server: ServerConfig {
                host: Some("10.0.0.4".into()),
                port: Some(1234),
            },
            ..Default::default()
        };
        assert_eq!(build_base_url(&cfg), "http://10.0.0.4:1234");
    }

    #[tokio::test]
    async fn find_project_ancestor_prefers_current_checkout() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project = tmp.path().join("project");
        let nested = project.join("a").join("b");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        tokio::fs::write(project.join("llm-wiki.md"), "# clio\n")
            .await
            .unwrap();

        let found = find_project_ancestor(&nested).await.unwrap();
        assert_eq!(found, project);
    }
}
