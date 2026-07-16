//! Startup branding for ADR-0005's idle CLI surfaces.  This module owns the
//! terminal boundary so working verbs cannot accidentally write banner bytes.

use std::io::{self, IsTerminal, Write};

const WORDMARK: &str = "V I B E S Y N C";
const TAGLINE: &str = "one-way file sync with SafetyNet · plan → review → run";
const PLAIN_BANNER: &str =
    "V I B E S Y N C — one-way file sync with SafetyNet · plan → review → run";

/// Whether these argv values select an idle surface.  This is intentionally
/// checked before clap renders help, because clap exits after doing so.
pub fn is_idle_surface(args: &[String]) -> bool {
    args.is_empty()
        || matches!(args, [help] if help == "--help")
        || matches!(args.first(), Some(command) if command == "tui")
}

/// Renders ADR-0005's startup header for both CLI and future TUI callers.
/// `plain` is the `NO_COLOR` form: a single, non-ANSI line.
pub fn render_startup_header(plain: bool) -> String {
    if plain {
        return PLAIN_BANNER.to_string();
    }

    // B4 from ADR-0005: a compact two-row mark plus a separate dim tagline.
    // The literal truecolor escapes are static; there is deliberately no
    // redraw or capability-probing protocol in v1.
    format!(
        "  \x1b[38;2;34;211;238m◢\x1b[38;2;168;85;247m█\x1b[38;2;236;72;153m◣\x1b[0m  \x1b[1m{WORDMARK}\x1b[0m\n  \x1b[38;2;34;211;238m◥\x1b[38;2;168;85;247m█\x1b[38;2;236;72;153m◤\x1b[0m\n       \x1b[2m{TAGLINE}\x1b[0m"
    )
}

/// Writes the static banner to stderr only when it is safe to decorate a
/// person-facing terminal.  All callers can invoke this unconditionally.
pub fn print_if_enabled() {
    if !io::stderr().is_terminal()
        || std::env::var_os("VIBESYNC_NO_BANNER").is_some_and(|v| v == "1")
    {
        return;
    }

    let mut stderr = io::stderr().lock();
    let _ = writeln!(
        stderr,
        "{}",
        render_startup_header(std::env::var_os("NO_COLOR").is_some())
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_only_idle_banner_surfaces() {
        assert!(is_idle_surface(&[]));
        assert!(is_idle_surface(&["--help".into()]));
        assert!(is_idle_surface(&["tui".into(), "photos".into()]));
        assert!(!is_idle_surface(&["-h".into()]));
        assert!(!is_idle_surface(&["plan".into(), "photos".into()]));
        assert!(!is_idle_surface(&["pair".into(), "list".into()]));
    }

    #[test]
    fn plain_header_is_one_line_without_ansi() {
        let header = render_startup_header(true);
        assert_eq!(header, PLAIN_BANNER);
        assert!(!header.contains("\x1b["));
    }
}
