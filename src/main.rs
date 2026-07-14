//! `vibesync`: hot-path verbs top-level, management namespaced, per
//! ADR-0004. This slice stubs the hot-path verbs and the TUI entry point;
//! only `pair add | list | remove` are implemented.

mod config;
mod error;
mod pair;
mod volume;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use config::Mode;
use error::AppError;

#[derive(Parser)]
#[command(name = "vibesync", version, about = "One-way file sync with SafetyNet")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show the diff of planned actions without mutating the destination.
    Plan { pair: String },
    /// Execute a run for a Folder pair.
    Run { pair: String },
    /// Show the last run's outcome for a Folder pair.
    Status { pair: String },
    /// Show past runs for a Folder pair.
    History { pair: String },
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

    let config_path = config::config_path();

    let result = run(&cli.command, &config_path);
    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => {
            eprintln!("vibesync: {e}");
            ExitCode::from(e.exit_code() as u8)
        }
    }
}

fn run(command: &Command, config_path: &std::path::Path) -> Result<i32, AppError> {
    match command {
        Command::Plan { pair } => Ok(not_yet_implemented("plan", pair)),
        Command::Run { pair } => Ok(not_yet_implemented("run", pair)),
        Command::Status { pair } => Ok(not_yet_implemented("status", pair)),
        Command::History { pair } => Ok(not_yet_implemented("history", pair)),
        Command::Prune { pair } => Ok(not_yet_implemented("prune", pair)),
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
    1
}
