//! NDJSON parser for the `/api/chat/send` response.
//!
//! The webapp pushes one JSON object per line. Events we care about:
//!
//! * `start` — session path lookup; surface once at the head.
//! * `chunk` — child stdout/stderr from the host coding-agent CLI; flushed
//!   verbatim so the user sees progress in real time.
//! * `progress` — sub-chunk / log heading; pretty-printed to stderr so it
//!   visually separates from the agent's prose.
//! * `done` — final assistant message + exitCode. Returned by the driver so
//!   callers can map it to a process exit code.
//! * `error` — terminal failure; propagated as an `anyhow::Error`.
//!
//! Anything else is ignored on purpose so the CLI stays forward-compatible
//! with new event kinds the webapp adds later.

use std::io::Write;

use anyhow::{anyhow, Result};
use bytes::Bytes;
use console::style;
use futures_util::{Stream, StreamExt};
use serde::Deserialize;

#[derive(Debug, Default)]
pub struct StreamOutcome {
    pub exit_code: i32,
    pub session_path: Option<String>,
    pub final_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Event {
    #[serde(rename = "start")]
    Start {
        #[serde(rename = "sessionPath")]
        session_path: String,
    },
    #[serde(rename = "chunk")]
    Chunk { stream: String, text: String },
    #[serde(rename = "progress")]
    Progress {
        #[serde(default)]
        phase: Option<String>,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        active: Option<String>,
        #[serde(default)]
        op: Option<String>,
        #[serde(default)]
        detail: Option<String>,
        #[serde(default)]
        ts: Option<String>,
    },
    #[serde(rename = "done")]
    Done {
        #[serde(default, rename = "exitCode")]
        exit_code: Option<i32>,
        #[serde(default, rename = "sessionPath")]
        session_path: Option<String>,
        #[serde(default)]
        assistant: Option<AssistantMessage>,
    },
    #[serde(rename = "error")]
    Error { error: String },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct AssistantMessage {
    #[serde(default)]
    content: Option<String>,
}

pub async fn consume<S>(mut stream: S, mut out: impl Write) -> Result<StreamOutcome>
where
    S: Stream<Item = reqwest::Result<Bytes>> + Unpin,
{
    let mut outcome = StreamOutcome::default();
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut printed_assistant_separator = false;

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|err| anyhow!("network error: {err}"))?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let trimmed = line
                .split(|&b| b == b'\n')
                .next()
                .unwrap_or(line.as_slice());
            if trimmed.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            let event: Event = match serde_json::from_slice(trimmed) {
                Ok(ev) => ev,
                Err(err) => {
                    // Don't fail the whole stream on a single malformed line —
                    // the webapp may add new event types we don't know yet.
                    eprintln!("{} unparseable ndjson line: {err}", style("warn:").yellow());
                    continue;
                }
            };
            handle_event(
                event,
                &mut out,
                &mut outcome,
                &mut printed_assistant_separator,
            )?;
        }
    }
    if !buf.is_empty() {
        if let Ok(event) = serde_json::from_slice::<Event>(&buf) {
            handle_event(
                event,
                &mut out,
                &mut outcome,
                &mut printed_assistant_separator,
            )?;
        }
    }
    Ok(outcome)
}

fn handle_event(
    event: Event,
    out: &mut impl Write,
    outcome: &mut StreamOutcome,
    printed_separator: &mut bool,
) -> Result<()> {
    match event {
        Event::Start { session_path } => {
            outcome.session_path = Some(session_path.clone());
            eprintln!(
                "{} session {}",
                style("clio:").cyan().bold(),
                style(session_path).dim()
            );
        }
        Event::Chunk { stream, text } => {
            if stream == "stderr" {
                let _ = write!(std::io::stderr(), "{text}");
                let _ = std::io::stderr().flush();
            } else {
                out.write_all(text.as_bytes())?;
                out.flush()?;
            }
        }
        Event::Progress {
            phase,
            summary,
            active,
            op,
            detail,
            ts,
        } => {
            let line = format_progress(
                phase.as_deref(),
                summary.as_deref(),
                active.as_deref(),
                op.as_deref(),
                detail.as_deref(),
                ts.as_deref(),
            );
            if let Some(rendered) = line {
                eprintln!("{} {}", style("·").dim(), rendered);
            }
        }
        Event::Done {
            exit_code,
            session_path,
            assistant,
        } => {
            outcome.exit_code = exit_code.unwrap_or(0);
            if let Some(sp) = session_path {
                outcome.session_path = Some(sp);
            }
            if let Some(asst) = assistant {
                if let Some(content) = asst.content {
                    if !content.is_empty() {
                        if !*printed_separator {
                            *printed_separator = true;
                            writeln!(out)?;
                        }
                        writeln!(out, "{content}")?;
                    }
                    outcome.final_text = Some(content);
                }
            }
            if outcome.exit_code != 0 {
                eprintln!(
                    "{} exit code {}",
                    style("clio:").yellow().bold(),
                    outcome.exit_code
                );
            }
        }
        Event::Error { error } => {
            return Err(anyhow!("server reported error: {error}"));
        }
        Event::Other => {}
    }
    Ok(())
}

fn format_progress(
    phase: Option<&str>,
    summary: Option<&str>,
    active: Option<&str>,
    op: Option<&str>,
    detail: Option<&str>,
    ts: Option<&str>,
) -> Option<String> {
    if let Some(sum) = summary {
        let mut s = sum.to_string();
        if let Some(active) = active {
            s.push_str(" · active=");
            s.push_str(active);
        }
        return Some(s);
    }
    if let (Some(op), Some(detail)) = (op, detail) {
        let ts = ts.unwrap_or("");
        return Some(format!("[{ts}] {op} | {detail}"));
    }
    phase.map(|p| p.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_summary_line() {
        let line = format_progress(
            Some("state"),
            Some("3/5 sub-chunks done"),
            Some("raw/foo"),
            None,
            None,
            None,
        );
        assert_eq!(
            line.as_deref(),
            Some("3/5 sub-chunks done · active=raw/foo")
        );
    }

    #[test]
    fn progress_log_line() {
        let line = format_progress(
            Some("log"),
            None,
            None,
            Some("ingest"),
            Some("foo bar"),
            Some("2026-05-20 10:00"),
        );
        assert_eq!(line.as_deref(), Some("[2026-05-20 10:00] ingest | foo bar"));
    }
}
