//! Throwaway prototype for wayfinder ticket #41: Commander-style Folder pair
//! and diff workflow. Renders fake data only — no config, no scan, no engine.
//!
//!   cargo run --example commander-panes           # interactive
//!   cargo run --example commander-panes -- --dump # plain-text dump, no TTY
//!
//! Keys: 1-4 switch review layout, 5..8 show volume/first-use states,
//! j/k move, space toggles inclusion, q quits.

use std::io::{self, Stdout};

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::{CrosstermBackend, TestBackend};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, List, ListItem, Paragraph, Row, Table};
use ratatui::{Frame, Terminal};

const ACCENT: Color = Color::Cyan;
const DIM: Color = Color::DarkGray;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Copy,
    Update,
    Delete,
    Same,
    Error,
}

impl Op {
    /// The gutter glyph: direction of travel, or the reason there is none.
    fn arrow(self) -> &'static str {
        match self {
            Op::Copy => "  →  ",
            Op::Update => "  →  ",
            Op::Delete => "  ✕  ",
            Op::Same => "  =  ",
            Op::Error => "  !  ",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Op::Copy => "COPY",
            Op::Update => "UPDATE",
            Op::Delete => "DELETE",
            Op::Same => "same",
            Op::Error => "ERROR",
        }
    }

    fn color(self) -> Color {
        match self {
            Op::Copy => Color::Cyan,
            Op::Update => Color::Yellow,
            Op::Delete => Color::Magenta,
            Op::Same => DIM,
            Op::Error => Color::Red,
        }
    }

    fn reviewable(self) -> bool {
        !matches!(self, Op::Same)
    }
}

struct RowData {
    left: &'static str,
    left_meta: &'static str,
    right: &'static str,
    right_meta: &'static str,
    op: Op,
    detail: &'static str,
    included: bool,
}

fn fixture() -> Vec<RowData> {
    vec![
        RowData {
            left: "2024/",
            left_meta: "412 MB",
            right: "2024/",
            right_meta: "398 MB",
            op: Op::Update,
            detail: "14 files differ",
            included: true,
        },
        RowData {
            left: "2025/reykjavik.raw",
            left_meta: "48.2 MB",
            right: "—",
            right_meta: "",
            op: Op::Copy,
            detail: "new in source",
            included: true,
        },
        RowData {
            left: "portraits.heic",
            left_meta: "6.1 MB",
            right: "portraits.heic",
            right_meta: "5.4 MB",
            op: Op::Update,
            detail: "content differs",
            included: true,
        },
        RowData {
            left: "notes.md",
            left_meta: "2 KB",
            right: "notes.md",
            right_meta: "2 KB",
            op: Op::Same,
            detail: "unchanged",
            included: false,
        },
        RowData {
            left: "—",
            left_meta: "",
            right: "old-scans/",
            right_meta: "1.2 GB",
            op: Op::Delete,
            detail: "absent in source",
            included: true,
        },
        RowData {
            left: "shortcut-to-nas",
            left_meta: "symlink",
            right: "—",
            right_meta: "",
            op: Op::Error,
            detail: "symlink unsupported on exFAT destination",
            included: true,
        },
    ]
}

struct App {
    rows: Vec<RowData>,
    cursor: usize,
    screen: u8,
}

impl App {
    fn new() -> Self {
        Self {
            rows: fixture(),
            cursor: 1,
            screen: 1,
        }
    }

    fn included_count(&self) -> usize {
        self.rows
            .iter()
            .filter(|r| r.op.reviewable() && r.included)
            .count()
    }

    fn blocked(&self) -> bool {
        self.rows.iter().any(|r| r.op == Op::Error && r.included)
    }
}

// ---------------------------------------------------------------- chrome

fn header(frame: &mut Frame, area: Rect, title: &str, subtitle: &str) {
    let text = vec![
        Line::from(vec![
            Span::styled("◢█◣ VIBESYNC  ", Style::default().fg(ACCENT)),
            Span::styled(title, Style::default().add_modifier(Modifier::BOLD)),
        ]),
        Line::from(Span::styled(subtitle, Style::default().fg(DIM))),
    ];
    frame.render_widget(Paragraph::new(text), area);
}

fn footer(frame: &mut Frame, area: Rect, app: &App, keys: &str) {
    // Screens with no plan behind them get keys only — no action count, no gate.
    let status = if !matches!(app.screen, 1..=4) {
        Line::from("")
    } else if app.blocked() {
        Line::from(Span::styled(
            " ! an included ERROR row blocks the Run — exclude it or fix the source ",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        ))
    } else {
        Line::from(vec![
            Span::raw(" "),
            Span::styled(
                format!("{} actions included", app.included_count()),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "  ·  replaced and deleted files go to _SafetyNet/<run-id>/",
                Style::default().fg(DIM),
            ),
        ])
    };
    frame.render_widget(Paragraph::new(status), area);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            keys,
            Style::default().fg(Color::Black).bg(DIM),
        ))),
        Rect {
            y: area.y + 1,
            height: 1,
            ..area
        },
    );
}

fn layout(area: Rect) -> (Rect, Rect, Rect) {
    let parts = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(6),
            Constraint::Length(2),
        ])
        .split(area);
    (parts[0], parts[1], parts[2])
}

// ------------------------------------------------- variant A: two panes

fn draw_variant_a(frame: &mut Frame, app: &App) {
    let (head, body, foot) = layout(frame.area());
    header(
        frame,
        head,
        "photos  ·  Mirror",
        "~/Photos   →   Backup Drive (exFAT)",
    );

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(45),
            Constraint::Length(7),
            Constraint::Percentage(45),
        ])
        .split(body);

    let mut left = Vec::new();
    // One blank item keeps the borderless gutter aligned with the bordered panes.
    let mut mid = vec![ListItem::new(Line::from(""))];
    let mut right = Vec::new();
    for (i, row) in app.rows.iter().enumerate() {
        let selected = i == app.cursor;
        let base = if selected {
            Style::default().bg(Color::Rgb(38, 42, 52))
        } else {
            Style::default()
        };
        let mark = if !row.op.reviewable() {
            "  "
        } else if row.included {
            "✓ "
        } else {
            "· "
        };
        left.push(ListItem::new(Line::from(vec![
            Span::styled(mark, base.fg(ACCENT)),
            Span::styled(format!("{:<28}", row.left), base),
            Span::styled(format!("{:>9}", row.left_meta), base.fg(DIM)),
        ])));
        mid.push(ListItem::new(Line::from(Span::styled(
            row.op.arrow(),
            base.fg(row.op.color()).add_modifier(Modifier::BOLD),
        ))));
        right.push(ListItem::new(Line::from(vec![
            Span::styled(format!("{:<28}", row.right), base),
            Span::styled(format!("{:>9}", row.right_meta), base.fg(DIM)),
        ])));
    }

    frame.render_widget(
        List::new(left).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" SOURCE  ~/Photos "),
        ),
        cols[0],
    );
    frame.render_widget(List::new(mid), cols[1]);
    frame.render_widget(
        List::new(right).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" DESTINATION  Backup Drive "),
        ),
        cols[2],
    );

    footer(
        frame,
        foot,
        app,
        " 1/2/3 layout · j k move · space include · tab switch pane · r Run · q quit ",
    );
}

// ------------------------------- variant B: panes browse, list reviews

fn draw_variant_b(frame: &mut Frame, app: &App) {
    let (head, body, foot) = layout(frame.area());
    header(
        frame,
        head,
        "photos  ·  Mirror  ·  review",
        "panes choose the pair — the action list reviews the plan (ADR-0003's unit of review)",
    );

    let split = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(5), Constraint::Min(4)])
        .split(body);

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(split[0]);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                "~/Photos",
                Style::default().add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "1,284 files · 4.1 GB",
                Style::default().fg(DIM),
            )),
        ])
        .block(Block::default().borders(Borders::ALL).title(" SOURCE ")),
        cols[0],
    );
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                "Backup Drive (exFAT) · /Volumes/Backup/Photos",
                Style::default().add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "1,209 files · 3.7 GB · connected",
                Style::default().fg(DIM),
            )),
        ])
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" DESTINATION "),
        ),
        cols[1],
    );

    let rows: Vec<Row> = app
        .rows
        .iter()
        .filter(|r| r.op.reviewable())
        .enumerate()
        .map(|(i, r)| {
            let selected = i == app.cursor.min(4);
            let base = if selected {
                Style::default().bg(Color::Rgb(38, 42, 52))
            } else {
                Style::default()
            };
            Row::new(vec![
                Cell::from(if r.included { " ✓" } else { " ·" }).style(base.fg(ACCENT)),
                Cell::from(r.op.name()).style(base.fg(r.op.color()).add_modifier(Modifier::BOLD)),
                Cell::from(if r.left == "—" { r.right } else { r.left }).style(base),
                Cell::from(r.detail).style(base.fg(DIM)),
            ])
        })
        .collect();

    frame.render_widget(
        Table::new(
            rows,
            [
                Constraint::Length(3),
                Constraint::Length(8),
                Constraint::Percentage(45),
                Constraint::Percentage(45),
            ],
        )
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" PLANNED ACTIONS "),
        ),
        split[1],
    );

    footer(
        frame,
        foot,
        app,
        " 1/2/3 layout · j k move · space include · r Run · q quit ",
    );
}

// ------- variant D: two-sided rows, named operations, no unchanged noise

fn draw_variant_d(frame: &mut Frame, app: &App) {
    let (head, body, foot) = layout(frame.area());
    header(
        frame,
        head,
        "photos  ·  Mirror",
        "~/Photos                    →  Backup Drive (exFAT) · connected",
    );

    let hidden = app.rows.iter().filter(|r| !r.op.reviewable()).count();
    let rows: Vec<Row> = app
        .rows
        .iter()
        .filter(|r| r.op.reviewable())
        .enumerate()
        .map(|(i, r)| {
            let selected = i == app.cursor.min(4);
            let base = if selected {
                Style::default().bg(Color::Rgb(38, 42, 52))
            } else {
                Style::default()
            };
            Row::new(vec![
                Cell::from(if r.included { " ✓" } else { " ·" }).style(base.fg(ACCENT)),
                Cell::from(r.op.name()).style(base.fg(r.op.color()).add_modifier(Modifier::BOLD)),
                Cell::from(format!("{}  {}", r.left, r.left_meta)).style(base),
                Cell::from(r.op.arrow()).style(base.fg(r.op.color())),
                Cell::from(format!("{}  {}", r.right, r.right_meta)).style(base),
                Cell::from(r.detail).style(base.fg(DIM)),
            ])
        })
        .collect();

    frame.render_widget(
        Table::new(
            rows,
            [
                Constraint::Length(2),
                Constraint::Length(8),
                Constraint::Percentage(32),
                Constraint::Length(5),
                Constraint::Percentage(30),
                Constraint::Percentage(26),
            ],
        )
        .header(
            Row::new(vec!["", " OP", " SOURCE", "", " DESTINATION", " WHY"])
                .style(Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)),
        )
        .block(Block::default().borders(Borders::ALL).title(format!(
            " PLAN  ·  {hidden} unchanged row(s) hidden — u to show "
        ))),
        body,
    );

    footer(
        frame,
        foot,
        app,
        " 1/2/3/4 layout · j k move · space include · u unchanged · r Run · q quit ",
    );
}

// ------------------------------------ variant C: one two-sided table

fn draw_variant_c(frame: &mut Frame, app: &App) {
    let (head, body, foot) = layout(frame.area());
    header(
        frame,
        head,
        "photos  ·  Mirror",
        "one table, both sides — no scroll to keep in sync",
    );

    let rows: Vec<Row> = app
        .rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let selected = i == app.cursor;
            let base = if selected {
                Style::default().bg(Color::Rgb(38, 42, 52))
            } else {
                Style::default()
            };
            let mark = if !r.op.reviewable() {
                "  "
            } else if r.included {
                " ✓"
            } else {
                " ·"
            };
            Row::new(vec![
                Cell::from(mark).style(base.fg(ACCENT)),
                Cell::from(format!("{}  {}", r.left, r.left_meta)).style(base),
                Cell::from(r.op.arrow()).style(base.fg(r.op.color()).add_modifier(Modifier::BOLD)),
                Cell::from(format!("{}  {}", r.right, r.right_meta)).style(base),
                Cell::from(r.detail).style(base.fg(DIM)),
            ])
        })
        .collect();

    frame.render_widget(
        Table::new(
            rows,
            [
                Constraint::Length(2),
                Constraint::Percentage(30),
                Constraint::Length(5),
                Constraint::Percentage(30),
                Constraint::Percentage(30),
            ],
        )
        .header(
            Row::new(vec!["", " SOURCE", "", " DESTINATION", " WHY"])
                .style(Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)),
        )
        .block(Block::default().borders(Borders::ALL)),
        body,
    );

    footer(
        frame,
        foot,
        app,
        " 1/2/3 layout · j k move · space include · r Run · q quit ",
    );
}

// ------------------------------------------------------ state screens

fn draw_state(frame: &mut Frame, app: &App, which: u8) {
    let (head, body, foot) = layout(frame.area());
    let (title, subtitle, lines) = match which {
        5 => (
            "first use",
            "no Folder pairs configured — the current directory seeds the source",
            vec![
                Line::from(Span::styled(
                    "  SOURCE   ~/Photos   (current directory)",
                    Style::default().add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "  DESTINATION   not chosen yet",
                    Style::default().fg(DIM),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "  Nothing has been scanned and nothing has been saved.",
                    Style::default().fg(DIM),
                )),
                Line::from(Span::styled(
                    "  Choose a destination, then  s  to save this as a Folder pair.",
                    Style::default().fg(DIM),
                )),
            ],
        ),
        6 => (
            "photos  ·  Mirror",
            "matched from the current directory",
            vec![
                Line::from(vec![
                    Span::styled("  ⚠  ", Style::default().fg(Color::Yellow)),
                    Span::styled(
                        "Destination volume Backup Drive (exFAT) is not connected.",
                        Style::default().add_modifier(Modifier::BOLD),
                    ),
                ]),
                Line::from(""),
                Line::from(Span::styled(
                    "  Last seen at /Volumes/Backup/Photos.",
                    Style::default().fg(DIM),
                )),
                Line::from(Span::styled(
                    "  Connect the volume and press  r  to re-check. Compare and Run are unavailable.",
                    Style::default().fg(DIM),
                )),
            ],
        ),
        7 => (
            "photos  ·  Mirror",
            "source cannot be read",
            vec![
                Line::from(vec![
                    Span::styled("  ⚠  ", Style::default().fg(Color::Red)),
                    Span::styled(
                        "Permission denied reading ~/Documents/Photos.",
                        Style::default().add_modifier(Modifier::BOLD),
                    ),
                ]),
                Line::from(""),
                Line::from(Span::styled(
                    "  This is NOT shown as an empty source: an empty Mirror source",
                    Style::default().fg(DIM),
                )),
                Line::from(Span::styled(
                    "  would plan to delete the whole destination.",
                    Style::default().fg(DIM),
                )),
                Line::from(Span::styled(
                    "  Grant Full Disk Access to your terminal, then  r  to re-check.",
                    Style::default().fg(DIM),
                )),
            ],
        ),
        _ => (
            "choose a Folder pair",
            "2 pairs configured · ★ marks the current directory",
            vec![
                Line::from(vec![
                    Span::styled("  ★ photos      ", Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)),
                    Span::raw("Mirror   ~/Photos → Backup Drive (exFAT)"),
                ]),
                Line::from(Span::styled(
                    "                 matched: you are standing in this pair's source",
                    Style::default().fg(DIM),
                )),
                Line::from(vec![
                    Span::raw("    docs-usb    "),
                    Span::raw("Update   ~/Documents → Field Stick (exFAT)"),
                ]),
                Line::from(Span::styled(
                    "                 ⚠ volume not connected",
                    Style::default().fg(Color::Yellow),
                )),
            ],
        ),
    };

    header(frame, head, title, subtitle);
    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL)),
        body,
    );
    footer(
        frame,
        foot,
        app,
        " 1-4 layouts · 5 first use · 6 volume absent · 7 unreadable · 8 pair picker · q quit ",
    );
}

fn draw(frame: &mut Frame, app: &App) {
    match app.screen {
        1 => draw_variant_a(frame, app),
        2 => draw_variant_b(frame, app),
        3 => draw_variant_c(frame, app),
        4 => draw_variant_d(frame, app),
        other => draw_state(frame, app, other),
    }
}

// ------------------------------------------------------------- drivers

fn dump() -> io::Result<()> {
    let labels = [
        (
            1,
            "VARIANT A — two panes with an operation gutter (FreeFileSync shape)",
        ),
        (
            2,
            "VARIANT B — panes select the pair, action list reviews the plan (ADR-0003 hybrid)",
        ),
        (
            3,
            "VARIANT C — one two-sided table, nothing to keep in scroll-sync",
        ),
        (
            4,
            "VARIANT D — named operations on two-sided rows, unchanged rows hidden",
        ),
        (5, "STATE — first use, current directory seeds the source"),
        (6, "STATE — destination volume absent"),
        (7, "STATE — source unreadable (never shown as empty)"),
        (8, "STATE — pair picker, current directory matched"),
    ];
    for (screen, label) in labels {
        let mut app = App::new();
        app.screen = screen;
        let mut terminal = Terminal::new(TestBackend::new(104, 18))?;
        terminal.draw(|frame| draw(frame, &app))?;
        let buffer = terminal.backend().buffer().clone();
        println!("\n{label}\n{}", "─".repeat(104));
        for y in 0..buffer.area.height {
            let mut line = String::new();
            for x in 0..buffer.area.width {
                line.push_str(buffer[(x, y)].symbol());
            }
            println!("{}", line.trim_end());
        }
    }
    Ok(())
}

fn interactive() -> io::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let result = event_loop(&mut terminal);
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    result
}

fn event_loop(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> io::Result<()> {
    let mut app = App::new();
    loop {
        terminal.draw(|frame| draw(frame, &app))?;
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
            KeyCode::Char(c @ '1'..='8') => app.screen = c as u8 - b'0',
            KeyCode::Char('j') | KeyCode::Down => {
                app.cursor = (app.cursor + 1).min(app.rows.len() - 1)
            }
            KeyCode::Char('k') | KeyCode::Up => app.cursor = app.cursor.saturating_sub(1),
            KeyCode::Char(' ') => {
                let row = &mut app.rows[app.cursor];
                if row.op.reviewable() {
                    row.included = !row.included;
                }
            }
            _ => {}
        }
    }
}

fn main() -> io::Result<()> {
    if std::env::args().any(|a| a == "--dump") {
        dump()
    } else {
        interactive()
    }
}
