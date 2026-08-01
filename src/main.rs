//! `vibesync`: hot-path verbs top-level, management namespaced, per
//! ADR-0004. Implemented so far: Folder-pair management, the human Dry-run,
//! safe `run`/`prune`, and Journal-backed `status`/`history`; the TUI and
//! streaming JSON plan/run surfaces remain later slices.

mod banner;
mod config;
mod error;
mod journal;
mod pair;
mod plan;
mod preconditions;
mod run;
mod volume;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{CommandFactory, Parser, Subcommand};

use config::Mode;
use error::AppError;

#[derive(Parser)]
#[command(
    name = "vibesync",
    version,
    about = "One-way file sync with SafetyNet",
    subcommand_required = false
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Show the diff of planned actions without mutating the destination.
    Plan {
        pair: String,
        /// Stream the plan as NDJSON (schema `vibefilesync.plan/v1`).
        #[arg(long)]
        json: bool,
        /// Exclude an exact plan path (repeatable); glob-free per ADR-0004.
        #[arg(long, value_name = "PATH")]
        exclude: Vec<String>,
    },
    /// Execute a run for a Folder pair.
    Run {
        pair: String,
        /// Skip the confirmation prompt (scripted/agent/cron use).
        #[arg(long)]
        yes: bool,
        /// Stream run events as NDJSON (schema `vibefilesync.run/v1`).
        #[arg(long)]
        json: bool,
        /// Delete archived versions permanently instead of via SafetyNet.
        #[arg(long)]
        permanent_delete: bool,
        /// Allow an empty source against a non-empty Mirror destination.
        #[arg(long)]
        allow_empty_source: bool,
        /// Skip the free-space preflight check.
        #[arg(long)]
        ignore_space_check: bool,
        /// Exclude an exact plan path (repeatable); glob-free per ADR-0004.
        #[arg(long, value_name = "PATH")]
        exclude: Vec<String>,
    },
    /// Show the last run's outcome for a Folder pair.
    Status { pair: String },
    /// Show past runs for a Folder pair.
    History {
        pair: String,
        /// Emit history as JSON (schema `vibefilesync.history/v1`).
        #[arg(long)]
        json: bool,
    },
    /// Delete SafetyNet Run folders for a Folder pair.
    Prune { pair: String },
    /// Manage Folder pairs.
    Pair {
        #[command(subcommand)]
        action: PairCommand,
    },
    /// Launch the TUI, optionally focused on one Folder pair.
    Tui { pair: Option<String> },
}

#[derive(Subcommand)]
enum PairCommand {
    /// Add a Folder pair, pinning both volumes by UUID.
    Add {
        name: String,
        #[arg(long)]
        source: PathBuf,
        #[arg(long)]
        destination: PathBuf,
        #[arg(long)]
        mode: Mode,
    },
    /// List configured Folder pairs.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Remove a Folder pair.
    Remove { name: String },
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if banner::is_idle_surface(&args) {
        banner::print_if_enabled();
    }

    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            e.print().ok();
            let code = match e.kind() {
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion => {
                    error::EXIT_OK
                }
                _ => error::EXIT_USAGE,
            };
            return ExitCode::from(code as u8);
        }
    };

    let Some(command) = cli.command else {
        Cli::command().print_help().ok();
        println!();
        return ExitCode::from(error::EXIT_OK as u8);
    };

    let config_path = config::config_path();

    let result = run(&command, &config_path);
    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => {
            eprintln!("vibesync: {e}");
            ExitCode::from(e.exit_code() as u8)
        }
    }
}

fn run(command: &Command, config_path: &std::path::Path) -> Result<i32, AppError> {
    // Every command loads (and so validates) the config first: a strict
    // TOML typo must abort loudly before any command-specific logic runs,
    // not just the `pair` ones (ADR-0006 §7).
    config::load(config_path)?;

    match command {
        Command::Plan {
            pair,
            json,
            exclude,
        } => {
            if *json {
                return plan::run_json(config_path, pair, exclude);
            }
            plan::run(config_path, pair, exclude)
        }
        Command::Run {
            pair,
            yes,
            json,
            permanent_delete,
            allow_empty_source,
            ignore_space_check,
            exclude,
        } => {
            if *json {
                return run::run_json(
                    config_path,
                    pair,
                    *yes,
                    *permanent_delete,
                    *allow_empty_source,
                    *ignore_space_check,
                    exclude,
                );
            }
            run::run(
                config_path,
                pair,
                *yes,
                *permanent_delete,
                *allow_empty_source,
                *ignore_space_check,
                exclude,
            )
        }
        Command::Status { pair } => journal::status(config_path, pair),
        Command::History { pair, json } => {
            if *json {
                journal::history_json(config_path, pair)
            } else {
                journal::history_human(config_path, pair)
            }
        }
        Command::Prune { pair } => run::prune(config_path, pair),
        Command::Tui { pair } => Ok(not_yet_implemented(
            "tui",
            pair.as_deref().unwrap_or("<all pairs>"),
        )),
        Command::Pair { action } => run_pair(action, config_path),
    }
}

fn run_pair(action: &PairCommand, config_path: &std::path::Path) -> Result<i32, AppError> {
    match action {
        PairCommand::Add {
            name,
            source,
            destination,
            mode,
        } => {
            pair::add(config_path, name, source, destination, *mode)?;
            Ok(error::EXIT_OK)
        }
        PairCommand::List { json } => {
            let output = if *json {
                pair::list_json(config_path)?
            } else {
                pair::list_table(config_path)?
            };
            print!("{output}");
            Ok(error::EXIT_OK)
        }
        PairCommand::Remove { name } => {
            pair::remove(config_path, name)?;
            Ok(error::EXIT_OK)
        }
    }
}

fn not_yet_implemented(verb: &str, pair: &str) -> i32 {
    eprintln!("vibesync {verb}: not yet implemented (pair: {pair})");
    error::EXIT_UNIMPLEMENTED
}
