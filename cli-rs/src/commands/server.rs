//! Local webapp lifecycle commands.
//!
//! Prefer the installed systemd service when it is discoverable, but fall back
//! to the checkout-local `setup.sh` so portable installs and developer clones
//! work on hosts without a service file.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::{anyhow, bail, Context as _, Result};
use clap::Args;
use console::style;

use crate::config::Context;

const DEFAULT_SERVICE: &str = "clio-web.service";

#[derive(Debug, Args)]
pub struct ServerArgs {
    /// Skip systemd detection and manage the webapp with setup.sh.
    #[arg(long)]
    pub no_systemd: bool,

    /// systemd service unit to use when available.
    #[arg(long, default_value = DEFAULT_SERVICE)]
    pub service: String,

    /// Use Next.js development mode when falling back to setup.sh.
    #[arg(long)]
    pub dev: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum ServerAction {
    Start,
    Shutdown,
    Restart,
}

impl ServerAction {
    fn systemctl_verb(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Shutdown => "stop",
            Self::Restart => "restart",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Shutdown => "shutdown",
            Self::Restart => "restart",
        }
    }
}

pub async fn run(ctx: &Context, action: ServerAction, args: ServerArgs) -> Result<u8> {
    if !args.no_systemd && systemd_unit_available(&args.service) {
        return run_systemd(action, &args.service);
    }

    run_setup_fallback(ctx, action, args.dev)
}

fn systemd_unit_available(service: &str) -> bool {
    let Ok(status) = Command::new("systemctl")
        .arg("cat")
        .arg(service)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    else {
        return false;
    };
    status.success()
}

fn run_systemd(action: ServerAction, service: &str) -> Result<u8> {
    println!(
        "{} using systemd service {service}",
        style(action.label()).bold()
    );
    let status = Command::new("systemctl")
        .arg(action.systemctl_verb())
        .arg(service)
        .status()
        .with_context(|| format!("failed to run systemctl {}", action.systemctl_verb()))?;

    if status.success() {
        return Ok(0);
    }

    if command_exists("sudo") {
        let status = Command::new("sudo")
            .arg("systemctl")
            .arg(action.systemctl_verb())
            .arg(service)
            .status()
            .with_context(|| format!("failed to run sudo systemctl {}", action.systemctl_verb()))?;
        if status.success() {
            return Ok(0);
        }
        bail!(
            "sudo systemctl {} {} exited with {}",
            action.systemctl_verb(),
            service,
            describe_status(status)
        );
    }

    bail!(
        "systemctl {} {} exited with {}; install sudo or run with privileges",
        action.systemctl_verb(),
        service,
        describe_status(status)
    );
}

fn run_setup_fallback(ctx: &Context, action: ServerAction, dev: bool) -> Result<u8> {
    let setup = ctx.project_root.join("setup.sh");
    if !setup.is_file() {
        bail!(
            "no systemd service is available and {} was not found",
            setup.display()
        );
    }

    println!("{} using {}", style(action.label()).bold(), setup.display());

    match action {
        ServerAction::Start => run_setup(ctx, &setup, setup_start_args(ctx, dev))?,
        ServerAction::Shutdown => run_setup(ctx, &setup, setup_shutdown_args(ctx))?,
        ServerAction::Restart => {
            run_setup(ctx, &setup, setup_shutdown_args(ctx))?;
            run_setup(ctx, &setup, setup_start_args(ctx, dev))?;
        }
    }
    Ok(0)
}

fn setup_start_args(ctx: &Context, dev: bool) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("--start"),
        OsString::from("--port"),
        OsString::from(ctx.server_port.to_string()),
        OsString::from("--host"),
        OsString::from(&ctx.server_host),
    ];
    if dev {
        args.push(OsString::from("--dev"));
    }
    args
}

fn setup_shutdown_args(ctx: &Context) -> Vec<OsString> {
    vec![
        OsString::from("--shutdown"),
        OsString::from("--port"),
        OsString::from(ctx.server_port.to_string()),
    ]
}

fn run_setup(ctx: &Context, setup: &PathBuf, args: Vec<OsString>) -> Result<()> {
    let status = Command::new(setup)
        .current_dir(&ctx.project_root)
        .args(args)
        .status()
        .with_context(|| format!("failed to run {}", setup.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!(
            "{} exited with {}",
            setup.display(),
            describe_status(status)
        ))
    }
}

fn command_exists(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

fn describe_status(status: std::process::ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("exit code {code}"),
        None => "signal termination".to_string(),
    }
}
