//! ADR-0003's thin action-list review UI. Planning and execution stay owned
//! by `plan` and `run`; this module only selects a Folder pair and produces
//! the exact reviewed action subset handed to the ordinary Run engine.

use std::fs;
use std::io::{self, IsTerminal, Stdout};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crossterm::cursor::{Hide, Show};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::{Backend, CrosstermBackend};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, Borders, Cell, List, ListItem, ListState, Paragraph, Row, Table, TableState, Wrap,
};
use ratatui::{Frame, Terminal};

use crate::banner::HeaderMode;
use crate::config::{self, Mode};
use crate::error::{AppError, EXIT_OK};
use crate::pair;
use crate::preconditions::{self, VolumeState};
use crate::volume;
use crate::{plan, run as run_engine};

#[derive(Clone)]
struct PairChoice {
    name: String,
    pair: config::Pair,
    source_view: SideView,
    destination_view: SideView,
}

/// One side's volume state as rendered for a person: a name-plus-filesystem
/// label (never a UUID) and a state sentence worded around its remedy —
/// reconnecting a drive is not the same act as restoring a folder, so the
/// six `VolumeState` variants get six distinct sentences, not one template
/// with a state name spliced in.
#[derive(Clone)]
struct SideView {
    description: String,
    /// Whether this side's state must block Compare and Run outright,
    /// rather than merely being warned about — the Inaccessible case is the
    /// one with a safety edge (an unreadable Mirror source reads like an
    /// empty one), but any state short of Ready/Relocated blocks the same
    /// way, since Compare could not resolve the pair regardless.
    blocked: bool,
    /// The short state name from `pair::state_name_and_location` — the same
    /// vocabulary `pair list --check` renders, reused here so the pair
    /// selector's compact per-side tag distinguishes all six `VolumeState`
    /// variants instead of collapsing them to `blocked`'s two.
    state_tag: &'static str,
}

fn side_view(
    state: &VolumeState,
    name: Option<&str>,
    path: &Path,
    relative_path: Option<&Path>,
) -> SideView {
    let base_label = pair::volume_label(name, path, relative_path);
    // `FolderMissing`'s `at` is precisely the folder that does not exist, so
    // probing it directly always fails; the volume it lives on is mounted
    // and readable, so probe that mount instead. `mount_point_for_path`
    // matches mount table entries by path prefix, so it still resolves even
    // though the exact folder is missing.
    let probe_path: PathBuf = match state {
        VolumeState::Relocated { at } | VolumeState::ForeignVolume { at } => at.clone(),
        VolumeState::FolderMissing { at } => {
            volume::mount_point_for_path(at).unwrap_or_else(|_| at.clone())
        }
        _ => path.to_path_buf(),
    };
    // Every label carries a filesystem segment, known or not: a bare name
    // reads as a complete, deliberate form, so a silently dropped
    // filesystem would be indistinguishable from one that was never
    // expected. Never guess the filesystem itself.
    let label = match volume::filesystem_type(&probe_path) {
        Ok(filesystem) => format!("{base_label} ({filesystem})"),
        Err(_) => format!("{base_label} (filesystem unknown)"),
    };
    let (description, blocked) = describe_state(state, &label);
    let (state_tag, _) = pair::state_name_and_location(state);
    SideView {
        description,
        blocked,
        state_tag,
    }
}

/// Six distinct sentences, one per `VolumeState`. Never say "empty" for
/// `Inaccessible`: Mirror mode reads an apparently-empty source as a request
/// to delete the whole destination, so an unreadable folder must say so.
fn describe_state(state: &VolumeState, label: &str) -> (String, bool) {
    match state {
        VolumeState::Ready => (format!("{label} — ready."), false),
        VolumeState::Relocated { at } => (
            format!(
                "{label} — reconnected at {} (a notice, not an error).",
                at.display()
            ),
            false,
        ),
        VolumeState::VolumeAbsent => (
            format!("{label} — disconnected. Reconnect the drive, then press r to refresh."),
            true,
        ),
        VolumeState::FolderMissing { at } => (
            format!(
                "{label} — the drive is connected, but the folder is missing at {}. Restore the folder, then press r to refresh.",
                at.display()
            ),
            true,
        ),
        VolumeState::ForeignVolume { at } => (
            format!(
                "A different volume is connected at {} where {label} is expected. Reconnect {label}, then press r to refresh.",
                at.display()
            ),
            true,
        ),
        VolumeState::Inaccessible => (
            format!(
                "{label} — present but unreadable (permission denied). Fix folder permissions, then press r to refresh."
            ),
            true,
        ),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Operation {
    Copy,
    Update,
    Delete,
    Cleanup,
    Error,
    /// Present, identical on both sides — revealed by `u` (ADR-0010 §2).
    /// Never constructed as a `ReviewRow`, so it never enters `rows`,
    /// `totals()`, `exclusions()`, or the reviewed subset; it exists only
    /// as a presentation row built straight from `Plan::unchanged_paths`.
    Unchanged,
}

impl Operation {
    fn label(self) -> &'static str {
        match self {
            Self::Copy => "＋ COPY",
            Self::Update => "↻ UPDATE",
            Self::Delete => "− DELETE",
            Self::Cleanup => "⌫ CLEANUP",
            Self::Error => "! ERROR",
            Self::Unchanged => "= UNCHANGED",
        }
    }

    fn color(self) -> Color {
        match self {
            Self::Copy => Color::Cyan,
            Self::Update => Color::Yellow,
            Self::Delete => Color::Magenta,
            Self::Cleanup => Color::Blue,
            Self::Error => Color::Red,
            Self::Unchanged => Color::DarkGray,
        }
    }

    fn uses_safety_net(self) -> bool {
        matches!(self, Self::Update | Self::Delete)
    }

    /// The direction glyph for the Review table's two-sided row (ADR-0010):
    /// Copy/Update actually move source content toward the destination, so
    /// they share the flow arrow; Delete and Cleanup remove something from
    /// the destination with no source content moving, Error moves nothing
    /// at all, and Unchanged is already identical on both sides — each of
    /// those gets a glyph that does not claim a flow that isn't happening.
    /// Never the only signal for an operation: the operation word in its
    /// own column always distinguishes it too.
    fn direction_glyph(self) -> &'static str {
        match self {
            Self::Copy | Self::Update => "→",
            Self::Delete | Self::Cleanup => "✕",
            Self::Error => "!",
            Self::Unchanged => "=",
        }
    }

    /// The two-sided cells for a row's path (ADR-0010, echoing ADR-0010 §3:
    /// "every copy or delete leaves one side as an em dash"). Update and
    /// Unchanged are the operations genuinely present on both sides; every
    /// other operation only has content on the side it actually affects.
    fn sides(self, path: &str) -> (String, String) {
        const ABSENT: &str = "—";
        match self {
            Self::Copy | Self::Error => (path.to_string(), ABSENT.to_string()),
            Self::Update | Self::Unchanged => (path.to_string(), path.to_string()),
            Self::Delete | Self::Cleanup => (ABSENT.to_string(), path.to_string()),
        }
    }
}

struct ReviewRow {
    included: bool,
    operation: Operation,
    path: String,
    bytes: Option<u64>,
    detail: String,
    structural_conflict: Option<plan::StructuralConflict>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Screen {
    Actions,
    Confirm,
}

struct ReviewModel {
    pair_name: String,
    pair: config::Pair,
    mode: Mode,
    destination: PathBuf,
    rows: Vec<ReviewRow>,
    selected: usize,
    screen: Screen,
    message: Option<String>,
    dry_run: plan::Plan,
    /// Run-precondition warnings, expected degradations and
    /// volume-relocation notices gathered by Compare — rendered inside the
    /// interface instead of printed to the plain terminal. Empty unless
    /// Compare set them.
    notices: Vec<String>,
    /// Whether the unchanged-file count (ADR-0010) is expanded into a
    /// visible summary row. Starts hidden every time Review is entered, so
    /// the table opens on what will happen, not on the unchanged majority;
    /// this is presentation state only and is never part of the reviewed
    /// action subset the engine receives.
    show_unchanged: bool,
}

#[derive(Default)]
struct Totals {
    copies: usize,
    updates: usize,
    deletes: usize,
    cleanups: usize,
    errors: usize,
    bytes: u64,
    excluded: usize,
}

enum ReviewOutcome {
    Cancelled,
    Execute(Vec<ReviewExclusion>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReviewExclusion {
    operation: Operation,
    path: String,
}

trait Events {
    fn next(&mut self) -> io::Result<Event>;

    /// Waits up to `timeout` for the next event, returning `None` if none
    /// arrived — used by Compare so a scan in progress can still be polled
    /// for completion while the terminal watches for a cancel keypress.
    fn poll(&mut self, timeout: Duration) -> io::Result<Option<Event>>;

    /// Un-reads an event so it is returned again, after anything already
    /// queued this way and before anything new — used when Compare reads
    /// ahead past keypresses meant for the stage a completing scan is about
    /// to land on. Call once per event, in the order they were read, to
    /// preserve that order on replay.
    fn push_back(&mut self, event: Event);
}

#[derive(Default)]
struct CrosstermEvents {
    buffered: std::collections::VecDeque<Event>,
}

impl Events for CrosstermEvents {
    fn next(&mut self) -> io::Result<Event> {
        if let Some(event) = self.buffered.pop_front() {
            return Ok(event);
        }
        event::read()
    }

    fn poll(&mut self, timeout: Duration) -> io::Result<Option<Event>> {
        if let Some(event) = self.buffered.pop_front() {
            return Ok(Some(event));
        }
        if event::poll(timeout)? {
            Ok(Some(event::read()?))
        } else {
            Ok(None)
        }
    }

    fn push_back(&mut self, event: Event) {
        self.buffered.push_back(event);
    }
}

/// The outcome of one Compare (a background, cancellable scan).
struct ScanOutcome {
    pair: config::Pair,
    dry_run: plan::Plan,
    notices: Vec<String>,
}

/// Injected so Compare's cancellability is exercised without a real
/// background thread or filesystem in the rendered-content test seam.
trait Scanner {
    /// Non-blocking: `None` means the scan is still running.
    fn poll(&mut self) -> Option<Result<ScanOutcome, AppError>>;
}

struct BackgroundScanner {
    receiver: mpsc::Receiver<Result<ScanOutcome, AppError>>,
}

impl BackgroundScanner {
    fn spawn(config_path: PathBuf, pair_name: String) -> Self {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(scan_pair(&config_path, &pair_name));
        });
        Self { receiver }
    }
}

impl Scanner for BackgroundScanner {
    fn poll(&mut self) -> Option<Result<ScanOutcome, AppError>> {
        self.receiver.try_recv().ok()
    }
}

/// Read-only: a fresh scan plus the same Run-precondition warnings and
/// expected degradations the CLI's Run edge would show, gathered here
/// instead so Compare can render them inside the interface rather than
/// printing them.
fn scan_pair(config_path: &Path, pair_name: &str) -> Result<ScanOutcome, AppError> {
    let cfg = config::load(config_path)?;
    let configured = cfg
        .pairs
        .get(pair_name)
        .cloned()
        .ok_or_else(|| AppError::Usage(format!("pair '{pair_name}' not found")))?;
    let (_, relocation_notices) = crate::preconditions::resolve_pair(&configured)?;
    let (pair, dry_run) = plan::build(config_path, pair_name, &[])?;
    let warnings = crate::preconditions::check_run(&pair, &dry_run, false, false)?;
    let degradations = crate::volume::expected_degradations(&pair.destination);
    let mut notices = relocation_notices;
    notices.extend(warnings);
    if !degradations.is_empty() {
        notices.push(format!(
            "vibesync: expected destination degradations: {}",
            degradations.join(", ")
        ));
    }
    Ok(ScanOutcome {
        pair,
        dry_run,
        notices,
    })
}

enum CompareOutcome {
    Cancelled,
    Ready(Box<ScanOutcome>),
}

fn compare<B: Backend, E: Events>(
    terminal: &mut Terminal<B>,
    events: &mut E,
    config_path: &Path,
    pair_name: &str,
    header_mode: HeaderMode,
) -> Result<CompareOutcome, AppError> {
    let config_path = config_path.to_path_buf();
    let pair_name_owned = pair_name.to_string();
    compare_with_scanner(terminal, events, pair_name, header_mode, move || {
        BackgroundScanner::spawn(config_path.clone(), pair_name_owned.clone())
    })
}

/// Opening a pair starts no scan: Compare first waits for an explicit
/// action, then runs the scan in the background so its progress can be
/// rendered and the whole thing abandoned — the scan is read-only, so
/// cancelling leaves the destination and the configuration untouched.
fn compare_with_scanner<B: Backend, E: Events, S: Scanner>(
    terminal: &mut Terminal<B>,
    events: &mut E,
    pair_name: &str,
    header_mode: HeaderMode,
    mut spawn_scanner: impl FnMut() -> S,
) -> Result<CompareOutcome, AppError> {
    let mut scanner: Option<S> = None;
    // Keypresses meant for the stage a completing scan lands on (e.g. Enter
    // to confirm) can arrive while the scan is still running. They are held
    // here, in the order they were read, and replayed via `push_back` —
    // Compare keeps polling for a cancel the whole time, so a scan in
    // progress stays abandonable no matter how many other keys were typed
    // ahead of it.
    let mut deferred_keys: Vec<Event> = Vec::new();
    loop {
        let comparing = scanner.is_some();
        terminal
            .draw(|frame| draw_compare(frame, pair_name, comparing, header_mode))
            .map_err(tui_error)?;

        if let Some(active) = scanner.as_mut() {
            if let Some(outcome) = active.poll() {
                return match outcome {
                    Ok(scan) => {
                        for event in deferred_keys {
                            events.push_back(event);
                        }
                        Ok(CompareOutcome::Ready(Box::new(scan)))
                    }
                    Err(error) => Err(error),
                };
            }
            if let Some(Event::Key(key)) =
                events.poll(Duration::from_millis(50)).map_err(tui_error)?
            {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                if matches!(key.code, KeyCode::Esc | KeyCode::Char('q')) {
                    return Ok(CompareOutcome::Cancelled);
                }
                deferred_keys.push(Event::Key(key));
            }
            continue;
        }

        let Event::Key(key) = events.next().map_err(tui_error)? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Enter | KeyCode::Char('c') => scanner = Some(spawn_scanner()),
            KeyCode::Esc | KeyCode::Char('q') => return Ok(CompareOutcome::Cancelled),
            _ => {}
        }
    }
}

/// What the Result stage renders: it persists until dismissed, and reports
/// counts, the SafetyNet Run folder, warnings and expected degradations —
/// read back from the Journal, the durable record of what actually ran.
struct ResultView {
    pair_name: String,
    mode: Mode,
    destination: PathBuf,
    notices: Vec<String>,
    record: Option<crate::journal::RunRecord>,
    interrupted: bool,
    message: Option<String>,
}

fn build_result_view(
    pair_name: &str,
    destination: &Path,
    mode: Mode,
    notices: Vec<String>,
    run_result: Result<i32, AppError>,
) -> Result<(i32, ResultView), AppError> {
    let finished = |code: i32, interrupted: bool, message: Option<String>| {
        let record = crate::journal::latest_record(pair_name).ok().flatten();
        (
            code,
            ResultView {
                pair_name: pair_name.to_string(),
                mode,
                destination: destination.to_path_buf(),
                notices,
                record,
                interrupted,
                message,
            },
        )
    };
    match run_result {
        Ok(code) => Ok(finished(code, false, None)),
        // An interrupted run already has a durable start record; report what
        // the Journal recorded rather than losing the screen to a raw error,
        // and say a rerun converges (ADR-0007: the Journal never becomes
        // copy authority, so a fresh scan is always safe to retry).
        Err(AppError::Interrupted(message)) => {
            let code = AppError::Interrupted(message.clone()).exit_code();
            Ok(finished(code, true, Some(message)))
        }
        Err(other) => Err(other),
    }
}

fn show_result<B: Backend, E: Events>(
    terminal: &mut Terminal<B>,
    events: &mut E,
    view: &ResultView,
    header_mode: HeaderMode,
) -> io::Result<()> {
    loop {
        terminal.draw(|frame| draw_result(frame, view, header_mode))?;
        let Event::Key(key) = events.next()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        if matches!(key.code, KeyCode::Enter | KeyCode::Char('q') | KeyCode::Esc) {
            return Ok(());
        }
    }
}

struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl TerminalSession {
    fn start() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen, Hide) {
            let _ = disable_raw_mode();
            return Err(error);
        }
        match Terminal::new(CrosstermBackend::new(stdout)) {
            Ok(terminal) => Ok(Self { terminal }),
            Err(error) => {
                let mut stdout = io::stdout();
                let _ = execute!(stdout, Show, LeaveAlternateScreen);
                let _ = disable_raw_mode();
                Err(error)
            }
        }
    }

    fn terminal(&mut self) -> &mut Terminal<CrosstermBackend<Stdout>> {
        &mut self.terminal
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(self.terminal.backend_mut(), Show, LeaveAlternateScreen);
        let _ = self.terminal.show_cursor();
    }
}

impl ReviewModel {
    fn from_plan(pair_name: &str, pair: &config::Pair, dry_run: plan::Plan) -> Self {
        let mut rows = Vec::with_capacity(
            dry_run.copies.len()
                + dry_run.updates.len()
                + dry_run.deletes.len()
                + dry_run.strays.len()
                + dry_run.errors.len(),
        );
        rows.extend(
            dry_run
                .copies
                .iter()
                .map(|action| ReviewRow::action(Operation::Copy, action)),
        );
        rows.extend(
            dry_run
                .updates
                .iter()
                .map(|action| ReviewRow::action(Operation::Update, action)),
        );
        rows.extend(
            dry_run
                .deletes
                .iter()
                .map(|action| ReviewRow::action(Operation::Delete, action)),
        );
        rows.extend(dry_run.strays.iter().map(|path| {
            ReviewRow {
                included: true,
                operation: Operation::Cleanup,
                path: path.to_string_lossy().into_owned(),
                bytes: fs::metadata(pair.destination.join(path))
                    .ok()
                    .map(|metadata| metadata.len()),
                detail: "abandoned temp".to_string(),
                structural_conflict: None,
            }
        }));
        rows.extend(dry_run.errors.iter().map(|error| ReviewRow {
            included: true,
            operation: Operation::Error,
            path: error.rel_path.to_string_lossy().into_owned(),
            bytes: None,
            detail: error.message.clone(),
            structural_conflict: None,
        }));
        Self {
            pair_name: pair_name.to_string(),
            pair: pair.clone(),
            mode: pair.mode,
            destination: pair.destination.clone(),
            rows,
            selected: 0,
            screen: Screen::Actions,
            message: None,
            dry_run,
            notices: Vec::new(),
            show_unchanged: false,
        }
    }

    fn totals(&self) -> Totals {
        let mut totals = Totals::default();
        for row in &self.rows {
            if !row.included {
                totals.excluded += 1;
                continue;
            }
            match row.operation {
                Operation::Copy => totals.copies += 1,
                Operation::Update => totals.updates += 1,
                Operation::Delete => totals.deletes += 1,
                Operation::Cleanup => totals.cleanups += 1,
                Operation::Error => totals.errors += 1,
                Operation::Unchanged => {
                    unreachable!("Unchanged is presentation-only and never a ReviewRow")
                }
            }
            totals.bytes += row.bytes.unwrap_or(0);
        }
        totals
    }

    fn exclusions(&self) -> Vec<ReviewExclusion> {
        self.rows
            .iter()
            .filter(|row| !row.included)
            .map(|row| ReviewExclusion {
                operation: row.operation,
                path: row.path.clone(),
            })
            .collect()
    }

    /// Builds the reviewed action subset without consuming the model, so a
    /// pair-lock collision at Run can return to Review with its selections
    /// (and dry-run scan) intact instead of forcing the whole flow to
    /// restart from Compare.
    fn reviewed_plan(&self, excludes: &[ReviewExclusion]) -> plan::Plan {
        let mut reviewed = self.dry_run.clone();
        let before = reviewed.copies.len()
            + reviewed.updates.len()
            + reviewed.deletes.len()
            + reviewed.errors.len()
            + reviewed.strays.len();
        let keep = |operation, path: &Path| {
            !excludes.iter().any(|excluded| {
                excluded.operation == operation && Path::new(&excluded.path) == path
            })
        };
        reviewed
            .copies
            .retain(|action| keep(Operation::Copy, &action.rel_path));
        reviewed
            .updates
            .retain(|action| keep(Operation::Update, &action.rel_path));
        reviewed
            .deletes
            .retain(|action| keep(Operation::Delete, &action.rel_path));
        reviewed
            .errors
            .retain(|error| keep(Operation::Error, &error.rel_path));
        reviewed.directory_copies.retain(|path| {
            reviewed
                .copies
                .iter()
                .any(|action| action.rel_path == *path)
        });
        reviewed.directory_deletes.retain(|path| {
            reviewed
                .deletes
                .iter()
                .any(|action| action.rel_path == *path)
        });
        let after = reviewed.copies.len()
            + reviewed.updates.len()
            + reviewed.deletes.len()
            + reviewed.errors.len()
            + reviewed.strays.len();
        reviewed.excluded += before - after;
        reviewed.unknown_excludes.clear();
        plan::drop_orphan_structural_deletions(&mut reviewed);
        reviewed
    }

    fn move_up(&mut self) {
        if self.rows.is_empty() {
            return;
        }
        self.selected = self.selected.saturating_sub(1);
    }

    fn move_down(&mut self) {
        if self.rows.is_empty() {
            return;
        }
        self.selected = (self.selected + 1).min(self.rows.len() - 1);
    }

    fn toggle(&mut self) {
        if let Some(row) = self.rows.get_mut(self.selected) {
            if row.operation == Operation::Cleanup {
                self.message = Some("Cleanup is mandatory for convergence".into());
                return;
            }
            row.included = !row.included;
            self.message = None;
        }
        let included_copies: Vec<String> = self
            .rows
            .iter()
            .filter(|row| row.included && row.operation == Operation::Copy)
            .map(|row| row.path.clone())
            .collect();
        for row in &mut self.rows {
            let dependency_present = match row.structural_conflict {
                Some(conflict) => included_copies
                    .iter()
                    .any(|copy| conflict.has_dependent_copy(Path::new(&row.path), Path::new(copy))),
                None => true,
            };
            if !dependency_present {
                row.included = false;
            }
        }
    }

    fn toggle_unchanged(&mut self) {
        self.show_unchanged = !self.show_unchanged;
    }
}

impl ReviewRow {
    fn action(operation: Operation, action: &plan::Action) -> Self {
        Self {
            included: true,
            operation,
            path: action.rel_path.to_string_lossy().into_owned(),
            bytes: Some(action.bytes),
            detail: action.reason.clone(),
            structural_conflict: action.structural_conflict,
        }
    }
}

pub fn run(config_path: &Path, requested_pair: Option<&str>) -> Result<i32, AppError> {
    ensure_interactive()?;
    let cfg = config::load(config_path)?;
    let choices = pair_choices(&cfg);
    let pair_name = match requested_pair {
        Some(name) => {
            if !cfg.pairs.contains_key(name) {
                return Err(AppError::Usage(format!("pair '{name}' not found")));
            }
            name.to_string()
        }
        None if choices.is_empty() => {
            return Err(AppError::Usage(
                "no Folder pairs configured; use `vibesync pair add` first".to_string(),
            ));
        }
        None if choices.len() == 1 => choices[0].name.clone(),
        None => match select_pair(&choices)? {
            Some(name) => name,
            None => return Ok(EXIT_OK),
        },
    };

    run_pair_flow(config_path, &pair_name)
}

/// Drives Compare, Review, Confirm, Run and Result for one already-chosen
/// Folder pair inside a single, continuously held alternate-screen session,
/// so Run-precondition warnings, expected degradations and
/// volume-relocation notices render as interface content instead of
/// ordinary terminal output.
fn run_pair_flow(config_path: &Path, pair_name: &str) -> Result<i32, AppError> {
    let mut session = TerminalSession::start().map_err(tui_error)?;
    let mut events = CrosstermEvents::default();
    let header_mode = crate::banner::header_mode();

    let cfg = config::load(config_path)?;
    let cfg_pair = cfg
        .pairs
        .get(pair_name)
        .cloned()
        .ok_or_else(|| AppError::Usage(format!("pair '{pair_name}' not found")))?;

    // Opening a pair resolves both sides fully (unlike the picker's
    // per-pinned-UUID mount check) and refuses Compare/Run outright while
    // either side is blocked, rather than merely warning about it.
    match pane_gate(
        session.terminal(),
        &mut events,
        pair_name,
        &cfg_pair,
        header_mode,
    )
    .map_err(tui_error)?
    {
        PaneOutcome::Cancelled => {
            drop(session);
            println!("Run cancelled; destination unchanged.");
            return Ok(EXIT_OK);
        }
        PaneOutcome::Proceed => {}
    }
    session.terminal().clear().map_err(tui_error)?;

    let compared = compare(
        session.terminal(),
        &mut events,
        config_path,
        pair_name,
        header_mode,
    )?;
    let (pair, dry_run, notices) = match compared {
        CompareOutcome::Cancelled => {
            drop(session);
            println!("Run cancelled; destination unchanged.");
            return Ok(EXIT_OK);
        }
        CompareOutcome::Ready(scan) => (scan.pair, scan.dry_run, scan.notices),
    };

    session.terminal().clear().map_err(tui_error)?;
    let mut model = ReviewModel::from_plan(pair_name, &pair, dry_run);
    model.notices = notices.clone();

    loop {
        let outcome = review_loop(session.terminal(), &mut events, &mut model, header_mode)
            .map_err(tui_error)?;
        let ReviewOutcome::Execute(excludes) = outcome else {
            drop(session);
            println!("Run cancelled; destination unchanged.");
            return Ok(EXIT_OK);
        };
        let reconciliation_excludes: Vec<String> = excludes
            .iter()
            .filter(|excluded| excluded.operation == Operation::Error)
            .map(|excluded| excluded.path.clone())
            .collect();
        let destination = model.destination.clone();
        let mode = model.mode;
        let reviewed_pair = model.pair.clone();
        let reviewed_plan = model.reviewed_plan(&excludes);

        let run_result = run_engine::run_reviewed(
            config_path,
            pair_name,
            run_engine::RunOptions {
                yes: true,
                permanent_delete: false,
                allow_empty_source: false,
                ignore_space_check: false,
                json_output: false,
                full_verify: false,
                // Ordinary actions are intersected with the reviewed Plan by
                // run_reviewed. Excluded error rows must also be absent from
                // its fresh plan-error gate; errors cannot share a path with
                // another source action, so this remains operation-safe.
                excludes: &reconciliation_excludes,
            },
            reviewed_pair,
            reviewed_plan,
        );

        // The pair lock is taken at execute, not at Compare: a collision
        // with another run in progress returns to Review with the model's
        // selections intact rather than tearing down the whole session.
        if is_lock_contention(&run_result) {
            model.screen = Screen::Actions;
            model.message = Some(
                "Another run is already in progress for this pair; try again once it finishes."
                    .to_string(),
            );
            continue;
        }

        let (exit_code, view) =
            build_result_view(pair_name, &destination, mode, notices.clone(), run_result)?;
        session.terminal().clear().map_err(tui_error)?;
        show_result(session.terminal(), &mut events, &view, header_mode).map_err(tui_error)?;
        return Ok(exit_code);
    }
}

fn is_lock_contention(run_result: &Result<i32, AppError>) -> bool {
    matches!(
        run_result,
        Err(AppError::Precondition(message)) if message == "run already in progress"
    )
}

fn ensure_interactive() -> Result<(), AppError> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(AppError::Usage(
            "tui requires an interactive terminal".to_string(),
        ));
    }
    Ok(())
}

fn pair_choices(config: &config::Config) -> Vec<PairChoice> {
    config
        .pairs
        .iter()
        .map(|(name, pair)| build_choice(name.clone(), pair.clone()))
        .collect()
}

/// Builds both sides' `SideView`s from a pair and its already-classified
/// states — the one place that assembles a `SideView` from a Folder pair's
/// fields, shared by the picker list (classified once, at list-build time)
/// and the pane gate (classified once on entry, again only on `r`).
fn side_views(
    cfg_pair: &config::Pair,
    source_state: &VolumeState,
    destination_state: &VolumeState,
) -> (SideView, SideView) {
    let source_view = side_view(
        source_state,
        cfg_pair.source_volume_name.as_deref(),
        &cfg_pair.source,
        cfg_pair.source_volume_relative_path.as_deref(),
    );
    let destination_view = side_view(
        destination_state,
        cfg_pair.destination_volume_name.as_deref(),
        &cfg_pair.destination,
        cfg_pair.destination_volume_relative_path.as_deref(),
    );
    (source_view, destination_view)
}

/// Classifies both sides once, at the point a pair enters the picker list —
/// never on a redraw or a timer, so the six-state read a user sees here
/// never changes underneath them without an explicit refresh.
fn build_choice(name: String, cfg_pair: config::Pair) -> PairChoice {
    let (source_state, destination_state) = preconditions::classify_pair(&cfg_pair);
    let (source_view, destination_view) = side_views(&cfg_pair, &source_state, &destination_state);
    PairChoice {
        name,
        pair: cfg_pair,
        source_view,
        destination_view,
    }
}

/// The outcome of the volume-state gate a pair passes through before
/// Compare: both sides are resolved fully (unlike the picker's per-pinned-
/// UUID mount check), and Compare/Run are refused outright rather than
/// merely warned about while either side is blocked.
enum PaneOutcome {
    Proceed,
    Cancelled,
}

/// Shows the two-sided pane view (Source / Destination) for one opened
/// pair. Classification runs once on entry and again only on an explicit
/// `r` refresh — nothing polls, so the screen a user is about to confirm
/// Compare from never changes underneath them.
fn pane_gate<B: Backend, E: Events>(
    terminal: &mut Terminal<B>,
    events: &mut E,
    pair_name: &str,
    cfg_pair: &config::Pair,
    header_mode: HeaderMode,
) -> io::Result<PaneOutcome> {
    let (mut source_state, mut destination_state) = preconditions::classify_pair(cfg_pair);
    let mut message: Option<String> = None;
    loop {
        let (source_view, destination_view) =
            side_views(cfg_pair, &source_state, &destination_state);
        let blocked = source_view.blocked || destination_view.blocked;
        terminal.draw(|frame| {
            draw_panes(
                frame,
                pair_name,
                &source_view,
                &destination_view,
                blocked,
                message.as_deref(),
                header_mode,
            )
        })?;

        let Event::Key(key) = events.next()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Char('r') | KeyCode::Char('R') => {
                let (source, destination) = preconditions::classify_pair(cfg_pair);
                source_state = source;
                destination_state = destination;
                message = None;
            }
            KeyCode::Enter | KeyCode::Char('c') => {
                if blocked {
                    message = Some(
                        "Compare disabled while a side needs attention above; reconnect or restore it, then press r to refresh."
                            .to_string(),
                    );
                } else {
                    return Ok(PaneOutcome::Proceed);
                }
            }
            KeyCode::Esc | KeyCode::Char('q') => return Ok(PaneOutcome::Cancelled),
            _ => {}
        }
    }
}

fn draw_panes(
    frame: &mut Frame<'_>,
    pair_name: &str,
    source: &SideView,
    destination: &SideView,
    blocked: bool,
    message: Option<&str>,
    header_mode: HeaderMode,
) {
    let [header, body, footer] = vertical_sections(frame.area(), header_mode);
    draw_header(frame, header, header_mode);

    let [left, right] = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .areas(body);

    draw_pane(frame, left, &format!("Source — {pair_name}"), source);
    draw_pane(
        frame,
        right,
        &format!("Destination — {pair_name}"),
        destination,
    );

    let base_help = if blocked {
        "BLOCKED: fix the side above, then press r to refresh · q cancel"
    } else {
        "Enter/c compare · r refresh · q cancel"
    };
    let help = match message {
        Some(message) => format!("{message} ({base_help})"),
        None => base_help.to_string(),
    };
    frame.render_widget(Paragraph::new(help), footer);
}

fn draw_pane(frame: &mut Frame<'_>, area: ratatui::layout::Rect, title: &str, view: &SideView) {
    let status_word = if view.blocked { "BLOCKED" } else { "OK" };
    let lines = vec![
        Line::from(Span::styled(
            status_word,
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(view.description.clone()),
    ];
    frame.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }).block(
            Block::default()
                .borders(Borders::ALL)
                .title(format!(" {title} ")),
        ),
        area,
    );
}

fn select_pair(choices: &[PairChoice]) -> Result<Option<String>, AppError> {
    let mut session = TerminalSession::start().map_err(tui_error)?;
    let mut events = CrosstermEvents::default();
    select_pair_loop(
        session.terminal(),
        &mut events,
        choices,
        crate::banner::header_mode(),
    )
    .map_err(tui_error)
}

fn select_pair_loop<B: Backend, E: Events>(
    terminal: &mut Terminal<B>,
    events: &mut E,
    choices: &[PairChoice],
    header_mode: HeaderMode,
) -> io::Result<Option<String>> {
    let mut selected = 0;
    loop {
        terminal.draw(|frame| draw_pair_selector(frame, choices, selected, header_mode))?;
        let Event::Key(key) = events.next()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => selected = selected.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => selected = (selected + 1).min(choices.len() - 1),
            KeyCode::Enter => return Ok(Some(choices[selected].name.clone())),
            KeyCode::Esc | KeyCode::Char('q') => return Ok(None),
            _ => {}
        }
    }
}

fn review_loop<B: Backend, E: Events>(
    terminal: &mut Terminal<B>,
    events: &mut E,
    model: &mut ReviewModel,
    header_mode: HeaderMode,
) -> io::Result<ReviewOutcome> {
    loop {
        terminal.draw(|frame| draw_review(frame, model, header_mode))?;
        let Event::Key(key) = events.next()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match model.screen {
            Screen::Actions => match key.code {
                KeyCode::Up | KeyCode::Char('k') => model.move_up(),
                KeyCode::Down | KeyCode::Char('j') => model.move_down(),
                KeyCode::Char(' ') => model.toggle(),
                KeyCode::Char('u') | KeyCode::Char('U') => model.toggle_unchanged(),
                KeyCode::Enter => {
                    model.screen = Screen::Confirm;
                    model.message = None;
                }
                KeyCode::Esc | KeyCode::Char('q') => return Ok(ReviewOutcome::Cancelled),
                _ => {}
            },
            Screen::Confirm => match key.code {
                KeyCode::Char('y') | KeyCode::Char('Y') => {
                    let errors = model.totals().errors;
                    if errors == 0 {
                        return Ok(ReviewOutcome::Execute(model.exclusions()));
                    }
                    model.message = Some(format!(
                        "Confirmation blocked: exclude or fix {errors} included error row(s)."
                    ));
                }
                KeyCode::Char('b') | KeyCode::Char('B') | KeyCode::Char('n') | KeyCode::Esc => {
                    model.screen = Screen::Actions;
                    model.message = None;
                }
                KeyCode::Char('q') => return Ok(ReviewOutcome::Cancelled),
                _ => {}
            },
        }
    }
}

fn draw_pair_selector(
    frame: &mut Frame<'_>,
    choices: &[PairChoice],
    selected: usize,
    header_mode: HeaderMode,
) {
    let [header, body, footer] = vertical_sections(frame.area(), header_mode);
    draw_header(frame, header, header_mode);
    let items = choices.iter().map(|choice| {
        // "OK"/"BLOCKED" keeps the at-a-glance runnable signal; the
        // `state_tag` suffix distinguishes Ready from Relocated within "OK"
        // and the four blocked states from each other within "BLOCKED" —
        // meaning carried entirely by these words, not by colour.
        let tag = |view: &SideView| {
            let signal = if view.blocked { "BLOCKED" } else { "OK" };
            format!("{signal} · {}", view.state_tag)
        };
        ListItem::new(vec![
            Line::from(vec![
                Span::styled(
                    choice.name.clone(),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Span::raw(format!("  ({})", choice.pair.mode)),
            ]),
            Line::from(format!(
                "Source [{}]: {}",
                tag(&choice.source_view),
                choice.source_view.description
            )),
            Line::from(format!(
                "Destination [{}]: {}",
                tag(&choice.destination_view),
                choice.destination_view.description
            )),
        ])
    });
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Select a Folder pair "),
        )
        .highlight_symbol("▶ ")
        .highlight_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );
    let mut state = ListState::default().with_selected(Some(selected));
    frame.render_stateful_widget(list, body, &mut state);
    frame.render_widget(
        Paragraph::new("↑/↓ or j/k move · Enter select · q cancel"),
        footer,
    );
}

fn draw_compare(frame: &mut Frame<'_>, pair_name: &str, comparing: bool, header_mode: HeaderMode) {
    let [header, body, footer] = vertical_sections(frame.area(), header_mode);
    draw_header(frame, header, header_mode);
    let (lines, help): (Vec<Line<'_>>, &str) = if comparing {
        (
            vec![Line::from(format!("Scanning '{pair_name}'…"))],
            "Esc/q abandon the scan · destination and configuration stay untouched",
        )
    } else {
        (
            vec![Line::from(format!(
                "Pair '{pair_name}' selected; no scan has started yet."
            ))],
            "Enter/c compare · q cancel",
        )
    };
    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(" Compare ")),
        body,
    );
    frame.render_widget(Paragraph::new(help), footer);
}

fn draw_result(frame: &mut Frame<'_>, view: &ResultView, header_mode: HeaderMode) {
    let [header, body, footer] = vertical_sections(frame.area(), header_mode);
    draw_header(frame, header, header_mode);
    let mut lines = vec![
        Line::from(Span::styled(
            format!("Result for '{}' ({})", view.pair_name, view.mode),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];
    if view.interrupted {
        lines.push(Line::from(Span::styled(
            "Run interrupted; running again converges.",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )));
        if let Some(message) = &view.message {
            lines.push(Line::from(message.clone()));
        }
        lines.push(Line::from(""));
    }
    match &view.record {
        Some(record) => {
            lines.push(Line::from(format!(
                "{} done · {} failed · {} planned",
                record.counts.done, record.counts.failed, record.counts.planned
            )));
            lines.push(Line::from(format!(
                "Bytes: {}",
                plan::human_size(record.bytes)
            )));
            lines.push(Line::from(format!("Warnings: {}", record.warnings)));
            lines.push(Line::from(format!(
                "SafetyNet Run folder: {}",
                view.destination
                    .join("_SafetyNet")
                    .join(&record.run_id)
                    .display()
            )));
        }
        None => lines.push(Line::from("No run record found in the Journal.")),
    }
    if !view.notices.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Notices:",
            Style::default().add_modifier(Modifier::BOLD),
        )));
        for notice in &view.notices {
            lines.push(Line::from(notice.clone()));
        }
    }
    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(" Result ")),
        body,
    );
    frame.render_widget(Paragraph::new("Enter/q dismiss"), footer);
}

fn draw_review(frame: &mut Frame<'_>, model: &ReviewModel, header_mode: HeaderMode) {
    let [header, body, footer] = vertical_sections(frame.area(), header_mode);
    draw_header(frame, header, header_mode);
    match model.screen {
        Screen::Actions => draw_actions(frame, body, model),
        Screen::Confirm => draw_confirmation(frame, body, model),
    }
    let help = match model.screen {
        Screen::Actions => {
            "↑/↓ or j/k move · Space include/exclude · u unchanged · Enter review confirmation · q cancel"
        }
        Screen::Confirm => "y confirm and run · b/n/Esc return to actions · q cancel",
    };
    frame.render_widget(Paragraph::new(help), footer);
}

fn vertical_sections(
    area: ratatui::layout::Rect,
    header_mode: HeaderMode,
) -> [ratatui::layout::Rect; 3] {
    let header_height = match header_mode {
        HeaderMode::Suppressed => 0,
        HeaderMode::Plain => 1,
        HeaderMode::Full => 3,
    };
    Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(header_height),
            Constraint::Min(5),
            Constraint::Length(1),
        ])
        .areas(area)
}

fn draw_header(frame: &mut Frame<'_>, area: ratatui::layout::Rect, mode: HeaderMode) {
    match mode {
        HeaderMode::Suppressed => {}
        HeaderMode::Plain => frame.render_widget(
            Paragraph::new(crate::banner::render_startup_header(true)),
            area,
        ),
        HeaderMode::Full => {
            let mut top = vec![Span::raw("  ")];
            top.extend(gradient_mark(crate::banner::MARK_TOP));
            top.push(Span::raw("  "));
            top.push(Span::styled(
                crate::banner::WORDMARK,
                Style::default().add_modifier(Modifier::BOLD),
            ));
            let mut bottom = vec![Span::raw("  ")];
            bottom.extend(gradient_mark(crate::banner::MARK_BOTTOM));
            let header = Paragraph::new(vec![
                Line::from(top),
                Line::from(bottom),
                Line::from(Span::styled(
                    format!("       {}", crate::banner::TAGLINE),
                    Style::default().add_modifier(Modifier::DIM),
                )),
            ]);
            frame.render_widget(header, area);
        }
    }
}

fn gradient_mark(mark: [&'static str; 3]) -> Vec<Span<'static>> {
    [
        (mark[0], Color::Rgb(34, 211, 238)),
        (mark[1], Color::Rgb(168, 85, 247)),
        (mark[2], Color::Rgb(236, 72, 153)),
    ]
    .into_iter()
    .map(|(symbol, color)| Span::styled(symbol, Style::default().fg(color)))
    .collect()
}

/// The Review stage's two-sided action table (ADR-0010, superseding
/// ADR-0003 §3): one row per planned action, columns in priority order —
/// include mark, operation name, source, direction glyph, destination,
/// reason. The row model is presentation derived from the `Plan` the engine
/// already produced; nothing here recomputes a diff.
fn draw_actions(frame: &mut Frame<'_>, area: ratatui::layout::Rect, model: &ReviewModel) {
    let rows = model.rows.iter().map(|row| {
        let check = if row.included { "[x]" } else { "[ ]" };
        let (source, destination) = row.operation.sides(&row.path);
        let mut reason = row.detail.clone();
        if let Some(bytes) = row.bytes {
            reason = format!("{reason} · {}", plan::human_size(bytes));
        }
        if row.operation.uses_safety_net() {
            reason = format!("{reason} · {}", plan::SAFETYNET_NOTE);
        }
        Row::new(vec![
            Cell::from(check),
            Cell::from(row.operation.label()).style(Style::default().fg(row.operation.color())),
            Cell::from(source),
            Cell::from(row.operation.direction_glyph()),
            Cell::from(destination),
            Cell::from(reason),
        ])
    });

    let unchanged = model.dry_run.unchanged;
    // Revealed rows come straight from `Plan::unchanged_paths` — the same
    // source every other row is derived from — never a recomputed diff.
    // The check column stays blank: unchanged items are not actions, so
    // they carry no include/exclude mark and never join `model.rows`
    // (ADR-0010 §2, criterion 6: the reviewed subset only ever comes from
    // `copies`/`updates`/`deletes`/`errors`).
    let unchanged_rows = model.dry_run.unchanged_paths.iter().map(|path| {
        let path = path.to_string_lossy();
        let (source, destination) = Operation::Unchanged.sides(&path);
        Row::new(vec![
            Cell::from(""),
            Cell::from(Operation::Unchanged.label())
                .style(Style::default().fg(Operation::Unchanged.color())),
            Cell::from(source),
            Cell::from(Operation::Unchanged.direction_glyph()),
            Cell::from(destination),
            Cell::from("identical on both sides"),
        ])
    });
    let rows: Vec<Row<'_>> = if model.show_unchanged {
        rows.chain(unchanged_rows).collect()
    } else {
        rows.collect()
    };

    let reveal_hint = if unchanged == 0 {
        String::new()
    } else if model.show_unchanged {
        format!(", {unchanged} unchanged shown (u to hide)")
    } else {
        format!(", {unchanged} unchanged hidden (u to show)")
    };
    let title = format!(
        " {} ({}) — {} action(s){reveal_hint} ",
        model.pair_name,
        model.mode,
        model.rows.len()
    );
    let table = Table::new(
        rows,
        [
            Constraint::Length(3),
            Constraint::Length(11),
            Constraint::Min(12),
            Constraint::Length(3),
            Constraint::Min(12),
            Constraint::Fill(2),
        ],
    )
    .header(
        Row::new(["", "Operation", "Source", "", "Destination", "Reason"])
            .style(Style::default().add_modifier(Modifier::BOLD)),
    )
    .block(Block::default().borders(Borders::ALL).title(title))
    .row_highlight_style(
        Style::default()
            .bg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    )
    .highlight_symbol("▶");
    let mut state = TableState::default();
    if !model.rows.is_empty() {
        state.select(Some(model.selected));
    }
    frame.render_stateful_widget(table, area, &mut state);
}

fn draw_confirmation(frame: &mut Frame<'_>, area: ratatui::layout::Rect, model: &ReviewModel) {
    let totals = model.totals();
    let safety_net = model.destination.join("_SafetyNet").join("<run-id>");
    let mut lines = vec![
        Line::from(Span::styled(
            format!("Confirm run for '{}' ({})", model.pair_name, model.mode),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(format!(
            "{} copy · {} update · {} delete · {} cleanup · {} error",
            totals.copies, totals.updates, totals.deletes, totals.cleanups, totals.errors
        )),
        Line::from(format!(
            "Included bytes: {}",
            plan::human_size(totals.bytes)
        )),
        Line::from(format!("SafetyNet: {}", safety_net.display())),
        Line::from(format!("Excluded this run: {}", totals.excluded)),
        Line::from(""),
    ];
    if totals.errors > 0 {
        lines.push(Line::from(Span::styled(
            format!(
                "BLOCKED: {} included error row(s) must be excluded or fixed.",
                totals.errors
            ),
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )));
    } else {
        lines.push(Line::from(Span::styled(
            "Ready: press y to execute this reviewed subset.",
            Style::default().fg(Color::Green),
        )));
    }
    if !model.notices.is_empty() {
        lines.push(Line::from(Span::styled(
            "Notices:",
            Style::default().add_modifier(Modifier::BOLD),
        )));
        for notice in &model.notices {
            lines.push(Line::from(notice.clone()));
        }
        lines.push(Line::from(""));
    }
    if let Some(message) = &model.message {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            message.clone(),
            Style::default().fg(Color::Red),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Review-first confirmation "),
        ),
        area,
    );
}

fn tui_error(error: io::Error) -> AppError {
    AppError::Precondition(format!("could not operate terminal UI: {error}"))
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::os::unix::fs::PermissionsExt;
    use std::time::SystemTime;

    use ratatui::backend::TestBackend;

    use super::*;

    /// Mirrors `CrosstermEvents`'s two tiers: `buffered` (events replayed
    /// via `push_back`, drained first) and `script` (the scripted future,
    /// never reordered) — so a deferred key can never jump ahead of
    /// not-yet-read scripted keys the way a single shared queue would.
    struct ScriptedEvents {
        script: VecDeque<Event>,
        buffered: VecDeque<Event>,
    }

    impl ScriptedEvents {
        fn keys(codes: impl IntoIterator<Item = KeyCode>) -> Self {
            Self {
                script: codes
                    .into_iter()
                    .map(|code| Event::Key(code.into()))
                    .collect(),
                buffered: VecDeque::new(),
            }
        }
    }

    impl Events for ScriptedEvents {
        fn next(&mut self) -> io::Result<Event> {
            if let Some(event) = self.buffered.pop_front() {
                return Ok(event);
            }
            self.script
                .pop_front()
                .ok_or_else(|| io::Error::other("script exhausted"))
        }

        fn poll(&mut self, _timeout: Duration) -> io::Result<Option<Event>> {
            if let Some(event) = self.buffered.pop_front() {
                return Ok(Some(event));
            }
            Ok(self.script.pop_front())
        }

        fn push_back(&mut self, event: Event) {
            self.buffered.push_back(event);
        }
    }

    struct ScriptedScanner(std::collections::VecDeque<Option<Result<ScanOutcome, AppError>>>);

    impl ScriptedScanner {
        fn pending(polls: usize, outcome: Result<ScanOutcome, AppError>) -> Self {
            let mut script = std::collections::VecDeque::new();
            for _ in 0..polls {
                script.push_back(None);
            }
            script.push_back(Some(outcome));
            Self(script)
        }
    }

    impl Scanner for ScriptedScanner {
        fn poll(&mut self) -> Option<Result<ScanOutcome, AppError>> {
            self.0.pop_front()?
        }
    }

    fn choice(name: &str, mode: Mode, source: &str, destination: &str) -> PairChoice {
        build_choice(
            name.to_string(),
            config::Pair {
                source: PathBuf::from(source),
                source_volume_uuid: String::new(),
                source_volume_name: None,
                source_volume_relative_path: None,
                destination: PathBuf::from(destination),
                destination_volume_uuid: String::new(),
                destination_volume_name: None,
                destination_volume_relative_path: None,
                mode,
            },
        )
    }

    fn pair(mode: Mode) -> config::Pair {
        config::Pair {
            source: PathBuf::from("/source"),
            source_volume_uuid: "source-uuid".to_string(),
            source_volume_name: None,
            source_volume_relative_path: None,
            destination: PathBuf::from("/Volumes/Backup/Photos"),
            destination_volume_uuid: "destination-uuid".to_string(),
            destination_volume_name: None,
            destination_volume_relative_path: None,
            mode,
        }
    }

    fn action(path: &str, bytes: u64, reason: &str) -> plan::Action {
        plan::Action {
            rel_path: PathBuf::from(path),
            bytes,
            source_mtime: Some(SystemTime::UNIX_EPOCH),
            old_bytes: None,
            reason: reason.to_string(),
            structural_conflict: None,
        }
    }

    fn buffer_text(terminal: &Terminal<TestBackend>) -> String {
        let buffer = terminal.backend().buffer();
        let mut output = String::new();
        for y in 0..24 {
            for x in 0..140 {
                output.push_str(buffer.cell((x, y)).unwrap().symbol());
            }
            output.push('\n');
        }
        output
    }

    #[test]
    fn confirm_screen_renders_notices_from_compare() {
        let mut model =
            ReviewModel::from_plan("photos", &pair(Mode::Mirror), plan::Plan::default());
        model.screen = Screen::Confirm;
        model.notices = vec!["vibesync: warning: _SafetyNet/ uses 42 bytes".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();

        terminal
            .draw(|frame| draw_review(frame, &model, HeaderMode::Full))
            .unwrap();

        let screen = buffer_text(&terminal);
        assert!(screen.contains("_SafetyNet/ uses 42 bytes"), "{screen}");
    }

    #[test]
    fn action_list_and_recomputed_confirmation_render_the_adr_contract() {
        let dry_run = plan::Plan {
            copies: vec![action("skip-me.txt", 5, "new")],
            deletes: vec![action("archive-me.txt", 3, "not in source")],
            strays: vec![PathBuf::from(".old.vibesync-tmp-run")],
            ..plan::Plan::default()
        };
        let mut model = ReviewModel::from_plan("photos", &pair(Mode::Mirror), dry_run);
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        let mut events =
            ScriptedEvents::keys([KeyCode::Char(' '), KeyCode::Enter, KeyCode::Char('q')]);

        let outcome =
            review_loop(&mut terminal, &mut events, &mut model, HeaderMode::Full).unwrap();

        assert!(matches!(outcome, ReviewOutcome::Cancelled));
        let screen = buffer_text(&terminal);
        for expected in [
            "0 copy · 0 update · 1 delete · 1 cleanup · 0 error",
            "Included bytes: 3 B",
            "SafetyNet: /Volumes/Backup/Photos/_SafetyNet/<run-id>",
            "Excluded this run: 1",
        ] {
            assert!(screen.contains(expected), "missing {expected:?}: {screen}");
        }

        model.screen = Screen::Actions;
        terminal
            .draw(|frame| draw_review(frame, &model, HeaderMode::Full))
            .unwrap();
        let screen = buffer_text(&terminal);
        for expected in [
            "[ ]",
            "＋",
            "COPY",
            "− DELETE",
            "⌫ CLEANUP",
            ".old.vibesync-tmp-run",
            "skip-me.txt",
            "5 B",
            plan::SAFETYNET_NOTE,
        ] {
            assert!(screen.contains(expected), "missing {expected:?}: {screen}");
        }
    }

    #[test]
    fn every_row_shows_both_sides_with_a_direction_glyph_and_an_em_dash_for_the_absent_side() {
        let mut deletion = action("changed.txt", 0, "old version");
        deletion.structural_conflict = None;
        let dry_run = plan::Plan {
            copies: vec![action("new.txt", 5, "new")],
            updates: vec![action("changed.txt", 7, "size changed")],
            deletes: vec![action("gone.txt", 3, "not in source")],
            strays: vec![PathBuf::from(".old.vibesync-tmp-run")],
            errors: vec![plan::PlanError {
                rel_path: PathBuf::from("link"),
                message: "symlink not supported".to_string(),
            }],
            ..plan::Plan::default()
        };
        let model = ReviewModel::from_plan("photos", &pair(Mode::Mirror), dry_run);
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();

        terminal
            .draw(|frame| draw_review(frame, &model, HeaderMode::Full))
            .unwrap();
        let screen = buffer_text(&terminal);

        // ADR-0010 §3: "every copy or delete leaves one side as an em dash".
        // Copy and Error show source only; Delete and Cleanup show
        // destination only; Update is the one operation shown on both sides.
        assert!(screen.contains("new.txt"), "{screen}");
        assert!(screen.contains("gone.txt"), "{screen}");
        assert!(screen.contains(".old.vibesync-tmp-run"), "{screen}");
        assert!(screen.contains("link"), "{screen}");
        assert!(screen.contains("changed.txt"), "{screen}");
        assert!(screen.contains('—'), "no em dash rendered: {screen}");
        assert!(screen.contains('→'), "no flow glyph rendered: {screen}");
        assert!(screen.contains('✕'), "no removal glyph rendered: {screen}");
    }

    #[test]
    fn every_operation_is_distinguishable_by_word_alone() {
        // Criterion 5: every operation must stay distinguishable with
        // colour disabled — verified here by asserting on the rendered
        // text only, never on any `Style`/`Color` field.
        for operation in [
            Operation::Copy,
            Operation::Update,
            Operation::Delete,
            Operation::Cleanup,
            Operation::Error,
            Operation::Unchanged,
        ] {
            assert!(operation.label().chars().any(|c| c.is_ascii_alphabetic()));
        }
        let labels: std::collections::HashSet<&str> = [
            Operation::Copy,
            Operation::Update,
            Operation::Delete,
            Operation::Cleanup,
            Operation::Error,
            Operation::Unchanged,
        ]
        .iter()
        .map(|op| op.label())
        .collect();
        assert_eq!(labels.len(), 6, "operation words must all be distinct");
    }

    #[test]
    fn unchanged_rows_are_hidden_by_default_with_their_count_visible_in_the_title() {
        let mut dry_run = plan::Plan {
            copies: vec![action("new.txt", 5, "new")],
            ..plan::Plan::default()
        };
        dry_run.unchanged = 42;
        let model = ReviewModel::from_plan("photos", &pair(Mode::Mirror), dry_run);
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();

        terminal
            .draw(|frame| draw_review(frame, &model, HeaderMode::Full))
            .unwrap();

        let screen = buffer_text(&terminal);
        assert!(screen.contains("42 unchanged hidden"), "{screen}");
        assert!(!screen.contains("identical on both sides"), "{screen}");
    }

    #[test]
    fn u_reveals_each_unchanged_item_as_its_own_row_and_toggles_back() {
        let mut dry_run = plan::Plan {
            copies: vec![action("new.txt", 5, "new")],
            unchanged_paths: vec![
                PathBuf::from("alpha.txt"),
                PathBuf::from("beta.txt"),
                PathBuf::from("gamma.txt"),
            ],
            ..plan::Plan::default()
        };
        dry_run.unchanged = 3;
        let mut model = ReviewModel::from_plan("photos", &pair(Mode::Mirror), dry_run);
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        let mut events = ScriptedEvents::keys([KeyCode::Char('u'), KeyCode::Char('q')]);

        review_loop(&mut terminal, &mut events, &mut model, HeaderMode::Full).unwrap();

        let screen = buffer_text(&terminal);
        assert!(screen.contains("3 unchanged shown"), "{screen}");
        // Each unchanged item is its own row — not one aggregate summary.
        assert!(screen.contains("alpha.txt"), "{screen}");
        assert!(screen.contains("beta.txt"), "{screen}");
        assert!(screen.contains("gamma.txt"), "{screen}");
        assert!(!screen.contains("3 file(s)"), "{screen}");
        assert!(screen.contains("identical on both sides"), "{screen}");
        assert!(screen.contains("UNCHANGED"), "{screen}");

        model.toggle_unchanged();
        terminal
            .draw(|frame| draw_review(frame, &model, HeaderMode::Full))
            .unwrap();
        let screen = buffer_text(&terminal);
        assert!(screen.contains("3 unchanged hidden"), "{screen}");
        assert!(!screen.contains("identical on both sides"), "{screen}");
        assert!(!screen.contains("alpha.txt"), "{screen}");
    }

    #[test]
    fn toggling_unchanged_never_changes_the_reviewed_action_subset() {
        let mut dry_run = plan::Plan {
            copies: vec![action("new.txt", 5, "new")],
            ..plan::Plan::default()
        };
        dry_run.unchanged = 3;
        let mut model = ReviewModel::from_plan("photos", &pair(Mode::Mirror), dry_run);

        model.toggle_unchanged();
        let exclusions = model.exclusions();
        let reviewed = model.reviewed_plan(&exclusions);

        assert_eq!(reviewed.copies.len(), 1);
        assert!(exclusions.is_empty());
    }

    #[test]
    fn included_error_cannot_confirm_but_excluding_it_can() {
        let dry_run = plan::Plan {
            errors: vec![plan::PlanError {
                rel_path: PathBuf::from("link"),
                message: "symlink not supported on exFAT destination".to_string(),
            }],
            ..plan::Plan::default()
        };
        let mut model = ReviewModel::from_plan("photos", &pair(Mode::Mirror), dry_run);
        let mut terminal = Terminal::new(TestBackend::new(120, 22)).unwrap();
        let mut events = ScriptedEvents::keys([
            KeyCode::Enter,
            KeyCode::Char('y'),
            KeyCode::Char('b'),
            KeyCode::Char(' '),
            KeyCode::Enter,
            KeyCode::Char('y'),
        ]);

        let outcome =
            review_loop(&mut terminal, &mut events, &mut model, HeaderMode::Full).unwrap();

        let ReviewOutcome::Execute(exclusions) = outcome else {
            panic!("included error confirmation must remain in the TUI")
        };
        assert_eq!(exclusions.len(), 1);
        assert_eq!(exclusions[0].operation, Operation::Error);
        assert_eq!(exclusions[0].path, "link");
    }

    #[test]
    fn cleanup_cannot_be_excluded_from_the_reviewed_plan() {
        let dry_run = plan::Plan {
            strays: vec![PathBuf::from(".old.vibesync-tmp-run")],
            ..plan::Plan::default()
        };
        let mut model = ReviewModel::from_plan("photos", &pair(Mode::Mirror), dry_run);
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        let mut events =
            ScriptedEvents::keys([KeyCode::Char(' '), KeyCode::Enter, KeyCode::Char('y')]);

        let outcome =
            review_loop(&mut terminal, &mut events, &mut model, HeaderMode::Full).unwrap();
        let ReviewOutcome::Execute(exclusions) = outcome else {
            panic!("mandatory cleanup should remain executable")
        };
        let reviewed = model.reviewed_plan(&exclusions);

        assert!(exclusions.is_empty());
        assert_eq!(reviewed.strays, [PathBuf::from(".old.vibesync-tmp-run")]);
        assert_eq!(reviewed.excluded, 0);
    }

    #[test]
    fn exclusion_identity_distinguishes_structural_delete_from_copy_at_same_path() {
        let mut deletion = action("report.txt", 0, "replaced by source file");
        deletion.structural_conflict = Some(plan::StructuralConflict::DestinationDirectory);
        let dry_run = plan::Plan {
            copies: vec![action("report.txt", 10, "new")],
            deletes: vec![deletion],
            ..plan::Plan::default()
        };
        let mut model = ReviewModel::from_plan("photos", &pair(Mode::Mirror), dry_run);

        model.toggle();
        let exclusions = model.exclusions();
        let reviewed = model.reviewed_plan(&exclusions);

        assert!(reviewed.copies.is_empty());
        assert!(reviewed.deletes.is_empty());
        assert_eq!(reviewed.excluded, 2);
    }

    #[test]
    fn descendant_copy_exclusion_also_drops_its_orphan_structural_delete() {
        let mut deletion = action("docs", 8, "replaced by source directory");
        deletion.structural_conflict = Some(plan::StructuralConflict::DestinationFile);
        let dry_run = plan::Plan {
            copies: vec![action("docs/new.txt", 10, "new")],
            deletes: vec![deletion],
            ..plan::Plan::default()
        };
        let mut model = ReviewModel::from_plan("photos", &pair(Mode::Update), dry_run);

        model.toggle();
        let totals = model.totals();
        let exclusions = model.exclusions();
        let reviewed = model.reviewed_plan(&exclusions);

        assert_eq!(totals.excluded, 2);
        assert!(reviewed.copies.is_empty());
        assert!(reviewed.deletes.is_empty());
    }

    #[test]
    fn pair_selector_uses_deterministic_keyboard_selection() {
        let choices = vec![
            choice(
                "documents",
                Mode::Mirror,
                "/documents",
                "/Volumes/Backup/Documents",
            ),
            choice("photos", Mode::Update, "/photos", "/Volumes/Backup/Photos"),
        ];
        let mut terminal = Terminal::new(TestBackend::new(100, 18)).unwrap();
        let mut events = ScriptedEvents::keys([KeyCode::Down, KeyCode::Enter]);

        let selected =
            select_pair_loop(&mut terminal, &mut events, &choices, HeaderMode::Full).unwrap();

        assert_eq!(selected.as_deref(), Some("photos"));
    }

    #[test]
    fn review_footer_uses_terminal_default_foreground() {
        let model = ReviewModel::from_plan("photos", &pair(Mode::Mirror), plan::Plan::default());
        let mut terminal = Terminal::new(TestBackend::new(100, 18)).unwrap();

        terminal
            .draw(|frame| draw_review(frame, &model, HeaderMode::Full))
            .unwrap();

        let footer_start = terminal.backend().buffer().cell((0, 17)).unwrap();
        assert_eq!(footer_start.symbol(), "↑");
        assert_eq!(footer_start.fg, Color::Reset);
    }

    #[test]
    fn pair_selector_footer_uses_terminal_default_foreground() {
        let choices = vec![choice(
            "photos",
            Mode::Mirror,
            "/photos",
            "/Volumes/Backup/Photos",
        )];
        let mut terminal = Terminal::new(TestBackend::new(100, 18)).unwrap();

        terminal
            .draw(|frame| draw_pair_selector(frame, &choices, 0, HeaderMode::Full))
            .unwrap();

        let footer_start = terminal.backend().buffer().cell((0, 17)).unwrap();
        assert_eq!(footer_start.symbol(), "↑");
        assert_eq!(footer_start.fg, Color::Reset);
    }

    #[test]
    fn tui_header_reuses_full_plain_and_suppressed_banner_modes() {
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();

        terminal
            .draw(|frame| {
                let area = frame.area();
                draw_header(frame, area, HeaderMode::Full);
            })
            .unwrap();
        let full = buffer_text(&terminal);
        assert!(full.contains("◢█◣  V I B E S Y N C"));
        assert!(full.contains(crate::banner::TAGLINE));
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer.cell((2, 0)).unwrap().fg, Color::Rgb(34, 211, 238));
        assert_eq!(buffer.cell((3, 0)).unwrap().fg, Color::Rgb(168, 85, 247));
        assert_eq!(buffer.cell((4, 0)).unwrap().fg, Color::Rgb(236, 72, 153));

        terminal.clear().unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                draw_header(frame, area, HeaderMode::Plain);
            })
            .unwrap();
        assert!(buffer_text(&terminal).contains(&crate::banner::render_startup_header(true)));

        terminal.clear().unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                draw_header(frame, area, HeaderMode::Suppressed);
            })
            .unwrap();
        assert!(!buffer_text(&terminal).contains(crate::banner::WORDMARK));
    }

    fn scan_outcome(mode: Mode) -> ScanOutcome {
        ScanOutcome {
            pair: pair(mode),
            dry_run: plan::Plan::default(),
            notices: vec!["vibesync: expected destination degradations: acls".to_string()],
        }
    }

    #[test]
    fn opening_a_pair_starts_no_scan_until_an_explicit_compare_action() {
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        let mut events = ScriptedEvents::keys([KeyCode::Char('q')]);
        let mut spawned = false;

        let outcome = compare_with_scanner(
            &mut terminal,
            &mut events,
            "photos",
            HeaderMode::Full,
            || {
                spawned = true;
                ScriptedScanner::pending(0, Ok(scan_outcome(Mode::Mirror)))
            },
        )
        .unwrap();

        assert!(matches!(outcome, CompareOutcome::Cancelled));
        assert!(!spawned, "cancelling before Enter must never start a scan");
        assert!(buffer_text(&terminal).contains("no scan has started yet"));
    }

    #[test]
    fn a_scan_in_progress_shows_progress_and_can_be_abandoned() {
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        // Enter starts Compare; the scan then stays pending across two
        // redraws before Esc abandons it — the scanner must never be asked
        // to produce its (unused) outcome.
        let mut events = ScriptedEvents::keys([KeyCode::Enter, KeyCode::Esc]);

        let outcome = compare_with_scanner(
            &mut terminal,
            &mut events,
            "photos",
            HeaderMode::Full,
            || ScriptedScanner::pending(5, Ok(scan_outcome(Mode::Mirror))),
        )
        .unwrap();

        assert!(matches!(outcome, CompareOutcome::Cancelled));
        assert!(buffer_text(&terminal).contains("Scanning 'photos'…"));
    }

    #[test]
    fn a_completed_scan_reaches_review_with_its_notices() {
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        let mut events = ScriptedEvents::keys([KeyCode::Enter]);

        let outcome = compare_with_scanner(
            &mut terminal,
            &mut events,
            "photos",
            HeaderMode::Full,
            || ScriptedScanner::pending(0, Ok(scan_outcome(Mode::Update))),
        )
        .unwrap();

        let CompareOutcome::Ready(scan) = outcome else {
            panic!("a completed scan must reach Review")
        };
        assert_eq!(scan.pair.mode, Mode::Update);
        assert_eq!(
            scan.notices,
            vec!["vibesync: expected destination degradations: acls".to_string()]
        );
    }

    #[test]
    fn result_stage_persists_reporting_counts_safety_net_and_notices() {
        let view = ResultView {
            pair_name: "photos".to_string(),
            mode: Mode::Mirror,
            destination: PathBuf::from("/Volumes/Backup/Photos"),
            notices: vec!["vibesync: expected destination degradations: acls".to_string()],
            record: Some(crate::journal::RunRecord {
                run_id: "20260801T120000Z".to_string(),
                result: "success".to_string(),
                counts: crate::journal::Counts {
                    planned: 2,
                    done: 2,
                    failed: 0,
                    copied: 1,
                    updated: 1,
                    deleted: 0,
                },
                bytes: 42,
                warnings: 0,
            }),
            interrupted: false,
            message: None,
        };
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        let mut events = ScriptedEvents::keys([KeyCode::Char('x'), KeyCode::Enter]);

        show_result(&mut terminal, &mut events, &view, HeaderMode::Full).unwrap();

        let screen = buffer_text(&terminal);
        for expected in [
            "2 done · 0 failed · 2 planned",
            "Bytes: 42 B",
            "Warnings: 0",
            "SafetyNet Run folder: /Volumes/Backup/Photos/_SafetyNet/20260801T120000Z",
            "expected destination degradations: acls",
        ] {
            assert!(screen.contains(expected), "missing {expected:?}: {screen}");
        }
    }

    #[test]
    fn interrupted_run_reports_the_journal_and_states_rerun_converges() {
        let (_, view) = build_result_view(
            "photos",
            Path::new("/Volumes/Backup/Photos"),
            Mode::Mirror,
            Vec::new(),
            Err(AppError::Interrupted(
                "run interrupted by signal".to_string(),
            )),
        )
        .unwrap();

        assert!(view.interrupted);
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        let mut events = ScriptedEvents::keys([KeyCode::Enter]);
        show_result(&mut terminal, &mut events, &view, HeaderMode::Full).unwrap();

        let screen = buffer_text(&terminal);
        assert!(screen.contains("Run interrupted; running again converges."));
        assert!(screen.contains("run interrupted by signal"));
    }

    #[test]
    fn a_non_interrupted_run_error_is_not_swallowed_into_a_result_screen() {
        let result = build_result_view(
            "photos",
            Path::new("/Volumes/Backup/Photos"),
            Mode::Mirror,
            Vec::new(),
            Err(AppError::Usage("pair 'photos' not found".to_string())),
        );

        match result {
            Err(AppError::Usage(_)) => {}
            _ => panic!("a non-interrupted run error must propagate, not render a Result screen"),
        }
    }

    #[test]
    fn pair_lock_contention_is_recognised_but_other_preconditions_are_not() {
        assert!(is_lock_contention(&Err(AppError::Precondition(
            "run already in progress".to_string()
        ))));
        assert!(!is_lock_contention(&Err(AppError::Precondition(
            "destination free space is insufficient".to_string()
        ))));
        assert!(!is_lock_contention(&Ok(0)));
    }

    #[test]
    fn all_six_volume_states_render_with_distinct_wording() {
        let states = [
            VolumeState::Ready,
            VolumeState::Relocated {
                at: PathBuf::from("/Volumes/Backup 1/Photos"),
            },
            VolumeState::VolumeAbsent,
            VolumeState::FolderMissing {
                at: PathBuf::from("/Volumes/Backup/Photos"),
            },
            VolumeState::ForeignVolume {
                at: PathBuf::from("/Volumes/Backup/Photos"),
            },
            VolumeState::Inaccessible,
        ];
        let descriptions: Vec<String> = states
            .iter()
            .map(|state| describe_state(state, "Backup Drive").0)
            .collect();
        let unique: std::collections::HashSet<&String> = descriptions.iter().collect();
        assert_eq!(unique.len(), descriptions.len(), "{descriptions:?}");
    }

    #[test]
    fn inaccessible_side_is_reported_as_unreadable_never_as_empty() {
        let (description, blocked) = describe_state(&VolumeState::Inaccessible, "Backup Drive");
        assert!(blocked);
        assert!(description.contains("unreadable"), "{description}");
        assert!(
            !description.to_lowercase().contains("empty"),
            "{description}"
        );
    }

    #[test]
    fn ready_and_relocated_never_block_but_the_other_four_states_do() {
        assert!(!describe_state(&VolumeState::Ready, "Backup Drive").1);
        assert!(
            !describe_state(
                &VolumeState::Relocated {
                    at: PathBuf::from("/Volumes/Backup 1")
                },
                "Backup Drive"
            )
            .1
        );
        assert!(describe_state(&VolumeState::VolumeAbsent, "Backup Drive").1);
        assert!(
            describe_state(
                &VolumeState::FolderMissing {
                    at: PathBuf::from("/Volumes/Backup")
                },
                "Backup Drive"
            )
            .1
        );
        assert!(
            describe_state(
                &VolumeState::ForeignVolume {
                    at: PathBuf::from("/Volumes/Backup")
                },
                "Backup Drive"
            )
            .1
        );
        assert!(describe_state(&VolumeState::Inaccessible, "Backup Drive").1);
    }

    #[test]
    fn foreign_volume_says_a_different_volume_is_connected_rather_than_the_pinned_one_being_disconnected(
    ) {
        let (description, _) = describe_state(
            &VolumeState::ForeignVolume {
                at: PathBuf::from("/Volumes/Backup/Photos"),
            },
            "Backup Drive",
        );
        assert!(description.contains("different volume"), "{description}");
        assert!(!description.contains("disconnected"), "{description}");
    }

    #[test]
    fn relocated_volume_reads_as_a_notice_not_an_error() {
        let (description, blocked) = describe_state(
            &VolumeState::Relocated {
                at: PathBuf::from("/Volumes/Backup 1/Photos"),
            },
            "Backup Drive",
        );
        assert!(!blocked);
        assert!(
            description.contains("notice, not an error"),
            "{description}"
        );
    }

    #[test]
    fn a_pair_with_no_captured_volume_name_still_renders_sensibly() {
        let choice = choice(
            "photos",
            Mode::Update,
            "/Volumes/Backup/Photos",
            "/Volumes/Backup/Photos2",
        );
        assert!(choice
            .source_view
            .description
            .contains("/Volumes/Backup/Photos"));
        assert!(!choice.source_view.description.is_empty());
    }

    #[test]
    fn name_plus_filesystem_renders_for_every_interface_state() {
        let dir = tempfile::tempdir().unwrap();
        let mounted = dir.path().to_path_buf();
        let missing_folder = mounted.join("gone");
        let restricted = mounted.join("locked");
        fs::create_dir(&restricted).unwrap();
        let mut perms = fs::metadata(&restricted).unwrap().permissions();
        perms.set_mode(0o000);
        fs::set_permissions(&restricted, perms.clone()).unwrap();
        let unmounted = PathBuf::from("/no/such/volume/anywhere-vibesync-test");

        let known_filesystem = [
            side_view(&VolumeState::Ready, Some("Backup Drive"), &mounted, None),
            side_view(
                &VolumeState::Relocated {
                    at: mounted.clone(),
                },
                Some("Backup Drive"),
                &mounted,
                None,
            ),
            side_view(
                &VolumeState::FolderMissing {
                    at: missing_folder.clone(),
                },
                Some("Backup Drive"),
                &mounted,
                None,
            ),
            side_view(
                &VolumeState::ForeignVolume {
                    at: mounted.clone(),
                },
                Some("Backup Drive"),
                &mounted,
                None,
            ),
            side_view(
                &VolumeState::Inaccessible,
                Some("Backup Drive"),
                &restricted,
                None,
            ),
        ];
        for view in &known_filesystem {
            assert!(
                view.description.contains("Backup Drive ("),
                "{}",
                view.description
            );
            assert!(
                !view
                    .description
                    .contains("Backup Drive (filesystem unknown"),
                "expected a real filesystem, got: {}",
                view.description
            );
        }

        let unknown_filesystem = side_view(
            &VolumeState::VolumeAbsent,
            Some("Backup Drive"),
            &unmounted,
            None,
        );
        assert!(
            unknown_filesystem
                .description
                .contains("Backup Drive (filesystem unknown)"),
            "{}",
            unknown_filesystem.description
        );

        fs::set_permissions(&restricted, {
            perms.set_mode(0o755);
            perms
        })
        .unwrap();
    }

    #[test]
    fn folder_missing_probes_the_mounted_volume_rather_than_the_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let mounted = dir.path().to_path_buf();
        let missing_folder = mounted.join("Photos");

        let view = side_view(
            &VolumeState::FolderMissing { at: missing_folder },
            Some("Backup Drive"),
            &mounted,
            None,
        );

        assert!(
            !view
                .description
                .starts_with("Backup Drive (filesystem unknown)"),
            "folder-missing should probe the mount point, not the missing folder: {}",
            view.description
        );
    }

    #[test]
    fn pair_list_never_renders_the_volume_uuid() {
        let mut cfg_pair = pair(Mode::Mirror);
        cfg_pair.source_volume_uuid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE".to_string();
        let choice = build_choice("photos".to_string(), cfg_pair);
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();

        terminal
            .draw(|frame| draw_pair_selector(frame, &[choice], 0, HeaderMode::Full))
            .unwrap();

        let screen = buffer_text(&terminal);
        assert!(!screen.contains("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"));
    }

    #[test]
    fn pair_selector_shows_a_distinct_status_per_side() {
        let choice = choice(
            "photos",
            Mode::Update,
            "/no/such/source",
            "/no/such/destination",
        );
        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();

        terminal
            .draw(|frame| draw_pair_selector(frame, &[choice], 0, HeaderMode::Full))
            .unwrap();

        let screen = buffer_text(&terminal);
        assert!(screen.contains("Source ["), "{screen}");
        assert!(screen.contains("Destination ["), "{screen}");
    }

    #[test]
    fn pair_selector_distinguishes_all_six_volume_states() {
        let dir = tempfile::tempdir().unwrap();
        let mounted = dir.path().to_path_buf();
        let missing_folder = mounted.join("gone");

        let states = [
            VolumeState::Ready,
            VolumeState::Relocated {
                at: mounted.clone(),
            },
            VolumeState::VolumeAbsent,
            VolumeState::FolderMissing {
                at: missing_folder.clone(),
            },
            VolumeState::ForeignVolume {
                at: mounted.clone(),
            },
            VolumeState::Inaccessible,
        ];

        let choices: Vec<PairChoice> = states
            .iter()
            .enumerate()
            .map(|(i, state)| PairChoice {
                name: format!("pair-{i}"),
                pair: pair(Mode::Update),
                source_view: side_view(state, Some("Backup Drive"), &mounted, None),
                destination_view: side_view(
                    &VolumeState::Ready,
                    Some("Backup Drive"),
                    &mounted,
                    None,
                ),
            })
            .collect();

        let mut terminal = Terminal::new(TestBackend::new(140, 60)).unwrap();
        terminal
            .draw(|frame| draw_pair_selector(frame, &choices, 0, HeaderMode::Full))
            .unwrap();
        let screen = buffer_text(&terminal);

        // Six distinct source tags: two "OK" states (Ready vs Relocated,
        // otherwise both collapsed under "OK") and four "BLOCKED" states
        // (otherwise all collapsed under "BLOCKED"), each still carrying
        // the shared runnable/not-runnable signal as a prefix word.
        assert!(screen.contains("Source [OK · ready]"), "{screen}");
        assert!(screen.contains("Source [OK · relocated]"), "{screen}");
        assert!(
            screen.contains("Source [BLOCKED · volume_absent]"),
            "{screen}"
        );
        assert!(
            screen.contains("Source [BLOCKED · folder_missing]"),
            "{screen}"
        );
        assert!(
            screen.contains("Source [BLOCKED · foreign_volume]"),
            "{screen}"
        );
        assert!(
            screen.contains("Source [BLOCKED · inaccessible]"),
            "{screen}"
        );
    }

    #[test]
    fn compare_is_disabled_not_merely_warned_about_while_a_side_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let restricted = dir.path().join("locked");
        fs::create_dir(&restricted).unwrap();
        let mut perms = fs::metadata(&restricted).unwrap().permissions();
        perms.set_mode(0o000);
        fs::set_permissions(&restricted, perms.clone()).unwrap();

        let mut cfg_pair = pair(Mode::Mirror);
        cfg_pair.source = restricted.clone();
        cfg_pair.source_volume_relative_path = Some(PathBuf::new());

        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        let mut events = ScriptedEvents::keys([KeyCode::Enter, KeyCode::Char('q')]);

        let outcome = pane_gate(
            &mut terminal,
            &mut events,
            "photos",
            &cfg_pair,
            HeaderMode::Full,
        )
        .unwrap();

        perms.set_mode(0o700);
        fs::set_permissions(&restricted, perms).unwrap();

        assert!(matches!(outcome, PaneOutcome::Cancelled));
        let screen = buffer_text(&terminal);
        assert!(screen.contains("BLOCKED"));
        assert!(screen.contains("unreadable"));
    }

    /// Delivers scripted keys but performs a filesystem side effect (fixing
    /// permissions) right before returning the `r` key — simulating a user
    /// physically reconnecting a drive and then pressing refresh.
    struct ReconnectEvents {
        path: PathBuf,
        keys: VecDeque<KeyCode>,
    }

    impl Events for ReconnectEvents {
        fn next(&mut self) -> io::Result<Event> {
            let code = self
                .keys
                .pop_front()
                .ok_or_else(|| io::Error::other("script exhausted"))?;
            if code == KeyCode::Char('r') {
                let mut perms = fs::metadata(&self.path).unwrap().permissions();
                perms.set_mode(0o700);
                fs::set_permissions(&self.path, perms).unwrap();
            }
            Ok(Event::Key(code.into()))
        }

        fn poll(&mut self, _timeout: Duration) -> io::Result<Option<Event>> {
            Ok(Some(self.next()?))
        }

        fn push_back(&mut self, _event: Event) {
            unimplemented!("unused by this test")
        }
    }

    #[test]
    fn refreshing_after_reconnecting_moves_a_blocked_pane_to_ready_with_no_restart() {
        let dir = tempfile::tempdir().unwrap();
        let source_uuid = volume::volume_uuid(dir.path()).unwrap();
        let mut perms = fs::metadata(dir.path()).unwrap().permissions();
        perms.set_mode(0o000);
        fs::set_permissions(dir.path(), perms.clone()).unwrap();

        let destination_dir = tempfile::tempdir().unwrap();
        let destination_uuid = volume::volume_uuid(destination_dir.path()).unwrap();

        let mut cfg_pair = pair(Mode::Update);
        cfg_pair.source = dir.path().to_path_buf();
        cfg_pair.source_volume_uuid = source_uuid;
        cfg_pair.source_volume_relative_path = Some(PathBuf::new());
        cfg_pair.destination = destination_dir.path().to_path_buf();
        cfg_pair.destination_volume_uuid = destination_uuid;
        cfg_pair.destination_volume_relative_path = Some(PathBuf::new());

        let mut terminal = Terminal::new(TestBackend::new(140, 24)).unwrap();
        let mut events = ReconnectEvents {
            path: dir.path().to_path_buf(),
            keys: [KeyCode::Enter, KeyCode::Char('r'), KeyCode::Enter]
                .into_iter()
                .collect(),
        };

        let outcome = pane_gate(
            &mut terminal,
            &mut events,
            "photos",
            &cfg_pair,
            HeaderMode::Full,
        )
        .unwrap();

        perms.set_mode(0o700);
        fs::set_permissions(dir.path(), perms).unwrap();

        assert!(matches!(outcome, PaneOutcome::Proceed));
    }
}
