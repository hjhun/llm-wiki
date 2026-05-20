//! Subcommand handlers.
//!
//! Each module exposes a `clap`-derived `…Args` (or `…Cmd` enum) and a
//! `run` async function returning `Result<u8>` so `main` can map it to the
//! process exit code.

pub mod ingest;
pub mod lint;
pub mod query;
pub mod raw;
pub mod status;
