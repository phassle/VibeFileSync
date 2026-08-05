//! Every code reference in the agent docs must resolve.
//!
//! The docs address code by symbol (`src/run.rs::execute_reviewed_plan`) rather than
//! by line number, because a line number is a position: insert anything above it and
//! the reference silently points at something else, while the path and the line both
//! still exist so nothing fails. A symbol survives edits above it, and when it stops
//! existing this test says so by name.
//!
//! Guarding the convention itself matters as much as guarding the references. A single
//! `path:line` reintroduced by hand would rot invisibly again, so this test rejects the
//! notation outright.
//!
//! What it deliberately cannot check: whether a reference names the *right* symbol. An
//! anchor pointing at a real function that has nothing to do with the sentence around it
//! passes every check here — that happened on this very file, where the in-process render
//! seam was anchored to the CLI fixture instead of to the `TestBackend` helpers that
//! actually implement it. Existence is mechanical; aptness is a reading. Treat a green run
//! as "no reference is dangling", never as "the docs are accurate".

use assert_cmd::Command;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

const DOCS: &[&str] = &[
    "AGENTS.md",
    "docs/architectural_patterns.md",
    ".agents/skills/use-vibesync/SKILL.md",
];

/// The file kinds the docs address. Every check below reads the same list, because
/// a kind one check knows and another does not is a hole: a `path:line` on it would
/// be rejected by neither the ban nor anything else.
const EXTENSIONS: &[&str] = &[".rs", ".toml", ".md", ".json", ".mts", ".lock"];

fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn read(relative: &str) -> String {
    let path = repo_root().join(relative);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("{relative} is readable: {error}"))
}

/// Pulls every `` `…` `` span out of a Markdown document.
fn backticked(doc: &str) -> Vec<String> {
    let mut spans = Vec::new();
    let mut rest = doc;
    while let Some(open) = rest.find('`') {
        rest = &rest[open + 1..];
        // Skip the `` `` `` fences used to show a literal backtick.
        if rest.starts_with('`') {
            rest = &rest[1..];
            continue;
        }
        match rest.find('`') {
            Some(close) => {
                spans.push(rest[..close].to_string());
                rest = &rest[close + 1..];
            }
            None => break,
        }
    }
    spans
}

/// The type an `impl` block declares against: `impl Drop for TerminalSession` and
/// `impl TerminalSession` both name `TerminalSession`. Everything else on the line —
/// the trait, its generic arguments, a where-clause — names nothing, so matching the
/// line as a whole would let any short name resolve against a coincidence.
fn impl_type(tail: &str) -> Option<String> {
    let subject = match tail.split_once(" for ") {
        Some((_, implementee)) => implementee.trim_start(),
        None => tail,
    };
    let ident: String = subject
        .rsplit("::")
        .next()
        .unwrap_or_default()
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    (!ident.is_empty()).then_some(ident)
}

/// A Rust item declaration for `name`, however it is spelled.
fn declares(source: &str, name: &str) -> bool {
    source.lines().any(|line| {
        let line = line.trim_start();
        for keyword in [
            "fn ", "struct ", "enum ", "const ", "static ", "trait ", "type ", "mod ", "impl ",
            "union ",
        ] {
            let head = line.strip_prefix("pub ").unwrap_or(line);
            let head = head
                .split_once(") ")
                .filter(|_| line.starts_with("pub("))
                .map(|(_, tail)| tail)
                .unwrap_or(head);
            if let Some(tail) = head.strip_prefix(keyword) {
                if keyword == "impl " {
                    // An impl header declares its type, not the trait it satisfies.
                    if impl_type(tail).as_deref() == Some(name) {
                        return true;
                    }
                    continue;
                }
                let ident: String = tail
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if ident == name {
                    return true;
                }
            }
        }
        false
    })
}

/// The impl branch is the one place a name can resolve against a line that does not
/// declare it. Pinning both directions keeps a later edit from widening it back into
/// a substring match, where a short name like `run` or `add` resolves by coincidence.
#[test]
fn declares_reads_impl_headers_by_type_not_by_substring() {
    let source = "\
impl Drop for TerminalSession {}
impl ReviewModel {}
impl fmt::Display for Mode {}
";
    // The type an impl block is for, whether the header names a trait or not.
    assert!(declares(source, "TerminalSession"));
    assert!(declares(source, "ReviewModel"));
    assert!(declares(source, "Mode"));
    // The trait, its path, and any fragment of either declare nothing here.
    assert!(!declares(source, "Drop"));
    assert!(!declares(source, "fmt"));
    assert!(!declares(source, "Display"));
    assert!(!declares(source, "Terminal"));
    assert!(!declares(source, "Review"));
}

#[test]
fn docs_never_reference_code_by_line_number() {
    let mut offenders = BTreeSet::new();
    for doc in DOCS {
        for span in backticked(&read(doc)) {
            let Some((path, tail)) = span.rsplit_once(':') else {
                continue;
            };
            // Trailing punctuation must not smuggle the notation past the ban:
            // `path:123.` and `path:123)` are line references too, and a check that
            // only rejects the tidy spelling is a check the next author routes around
            // without meaning to.
            let tail = tail.trim_end_matches(|c: char| !c.is_ascii_digit());
            if tail.is_empty() || !tail.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if EXTENSIONS.iter().any(|ext| path.ends_with(ext)) {
                offenders.insert(format!("{doc}: `{span}`"));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "reference code by symbol, not by line number — a line number silently retargets \
         when anything above it moves:\n  {}",
        offenders.iter().cloned().collect::<Vec<_>>().join("\n  ")
    );
}

#[test]
fn every_documented_symbol_exists() {
    let mut missing = BTreeSet::new();
    for doc in DOCS {
        for span in backticked(&read(doc)) {
            let Some((relative, symbol)) = span.split_once("::") else {
                continue;
            };
            if !relative.ends_with(".rs") {
                continue;
            }
            // `Type::method` inside prose is not a file reference.
            if !relative.contains('/') {
                continue;
            }
            let path = repo_root().join(relative);
            let Ok(source) = fs::read_to_string(&path) else {
                missing.insert(format!("{doc}: `{span}` — {relative} does not exist"));
                continue;
            };
            let symbol = symbol.split_whitespace().next().unwrap_or(symbol);
            if !declares(&source, symbol) {
                missing.insert(format!(
                    "{doc}: `{span}` — {relative} declares no `{symbol}`"
                ));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "documented symbols no longer exist:\n  {}",
        missing.iter().cloned().collect::<Vec<_>>().join("\n  ")
    );
}

#[test]
fn every_documented_path_exists() {
    let mut missing = BTreeSet::new();
    for doc in DOCS {
        for span in backticked(&read(doc)) {
            // `Cargo.toml [dependencies]` and `package.json "devDependencies"`.
            let candidate = span
                .split_once(' ')
                .map(|(head, _)| head)
                .unwrap_or(&span)
                .trim_end_matches('.');
            let candidate = candidate.split("::").next().unwrap_or(candidate);
            if !candidate.contains('/') && !candidate.contains('.') {
                continue;
            }
            // Paths outside the repository — a user's config location, an absolute
            // path in an example — are documentation, not references to check.
            if candidate.starts_with('~') || candidate.starts_with('/') {
                continue;
            }
            if !EXTENSIONS.iter().any(|ext| candidate.ends_with(ext)) {
                continue;
            }
            if !repo_root().join(candidate).exists() {
                missing.insert(format!("{doc}: `{span}` — {candidate} does not exist"));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "documented paths do not exist:\n  {}",
        missing.iter().cloned().collect::<Vec<_>>().join("\n  ")
    );
}

/// `Cargo.toml [dependencies]` and `package.json "devDependencies"` name a place
/// inside a file. Checking only that the file exists leaves the half that actually
/// moves — the section, the key — unguarded, which is the same rot as a line number.
/// A reference list that names the same thing twice says nothing the second time.
///
/// These appear when positional references are converted to symbols: two distinct line
/// numbers inside one function collapse to one name, and the duplicate survives as noise.
/// Repeats *across* lists are fine and often correct — several sub-steps of Publish really
/// do live in `copy_file`, which is the honest cost of naming over positioning. Only a
/// repeat within a single reference list is meaningless.
#[test]
fn no_reference_list_names_the_same_thing_twice() {
    let mut repeats = BTreeSet::new();
    for doc in DOCS {
        for (number, line) in read(doc).lines().enumerate() {
            let refs: Vec<String> = backticked(line)
                .into_iter()
                .filter(|span| {
                    let head = span.split(&[' ', ':'][..]).next().unwrap_or(span);
                    EXTENSIONS.iter().any(|ext| head.ends_with(ext))
                })
                .collect();
            for span in &refs {
                if refs.iter().filter(|other| *other == span).count() > 1 {
                    repeats.insert(format!("{doc}:{}: `{span}` appears twice", number + 1));
                }
            }
        }
    }
    assert!(
        repeats.is_empty(),
        "a reference list names the same thing twice:\n  {}",
        repeats.iter().cloned().collect::<Vec<_>>().join("\n  ")
    );
}

#[test]
fn every_documented_section_exists() {
    let mut missing = BTreeSet::new();
    for doc in DOCS {
        for span in backticked(&read(doc)) {
            let Some((relative, anchor)) = span.split_once(' ') else {
                continue;
            };
            let anchor = anchor.trim();
            if !EXTENSIONS.iter().any(|ext| relative.ends_with(ext)) {
                continue;
            }
            // A file that does not exist is every_documented_path_exists' report.
            let Ok(source) = fs::read_to_string(repo_root().join(relative)) else {
                continue;
            };
            let found = if anchor.starts_with('[') && anchor.ends_with(']') {
                // A TOML section header stands alone on its line.
                source.lines().any(|line| line.trim() == anchor)
            } else if anchor.len() > 1 && anchor.starts_with('"') && anchor.ends_with('"') {
                // A JSON key is quoted and followed by its colon.
                source.lines().any(|line| {
                    line.trim_start()
                        .strip_prefix(anchor)
                        .is_some_and(|rest| rest.trim_start().starts_with(':'))
                })
            } else {
                // Prose after a path, not an anchor into it.
                continue;
            };
            if !found {
                missing.insert(format!("{doc}: `{span}` — {relative} has no {anchor}"));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "documented sections and keys do not exist:\n  {}",
        missing.iter().cloned().collect::<Vec<_>>().join("\n  ")
    );
}

/// The subcommand path and `--flag`s of a documented `vibesync ...` invocation.
/// Subcommands are the leading run of tokens before the first flag-looking
/// one; flags are every later token that itself starts with `-`. A bare token
/// after the first flag (e.g. a placeholder like `<PATH>` documenting a
/// flag's argument) is neither: skipping it keeps that placeholder from
/// being checked as if it were a second flag or a subcommand. `None` for a
/// span that isn't a `vibesync` invocation at all — most backticked spans
/// are paths or symbols, not commands.
fn cli_invocation(span: &str) -> Option<(Vec<&str>, Vec<&str>)> {
    let mut tokens = span.split_whitespace();
    if tokens.next()? != "vibesync" {
        return None;
    }
    let tokens: Vec<&str> = tokens.collect();
    let split = tokens
        .iter()
        .position(|token| token.starts_with('-'))
        .unwrap_or(tokens.len());
    let (subcommands, rest) = tokens.split_at(split);
    let flags: Vec<&str> = rest
        .iter()
        .copied()
        .filter(|token| token.starts_with('-'))
        .collect();
    Some((subcommands.to_vec(), flags))
}

/// `vibesync <path> --help`'s stdout, run against the real built binary —
/// never a glob engine or a hand-maintained list of flags.
fn help_output(path: &[&str]) -> String {
    let mut cmd = Command::cargo_bin("vibesync").expect("binary builds");
    cmd.args(path).arg("--help");
    let output = cmd.output().expect("vibesync --help runs");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Whether `--help`'s `Commands:` block lists `name` as a subcommand.
fn help_lists_command(help: &str, name: &str) -> bool {
    let mut in_commands = false;
    for line in help.lines() {
        if line.trim_end() == "Commands:" {
            in_commands = true;
            continue;
        }
        if !in_commands {
            continue;
        }
        if line.trim().is_empty() {
            break;
        }
        if line.split_whitespace().next() == Some(name) {
            return true;
        }
    }
    false
}

/// Whether `--help`'s `Options:` block lists `flag` (bare, no `=value`).
fn help_lists_option(help: &str, flag: &str) -> bool {
    let mut in_options = false;
    for line in help.lines() {
        if line.trim_end() == "Options:" {
            in_options = true;
            continue;
        }
        if !in_options {
            continue;
        }
        if line.trim().is_empty() {
            break;
        }
        if line
            .trim_start()
            .split(',')
            .map(str::trim)
            .any(|part| part == flag || part.starts_with(&format!("{flag} ")))
        {
            return true;
        }
    }
    false
}

/// Every fenced `vibesync ...` invocation an agent doc shows must resolve
/// against the real binary's own `--help`: each subcommand it names must be
/// listed at that level, and each `--flag` it passes must be listed on that
/// exact invocation's help. No glob engine, no invented flags, no exit-code
/// strings the binary doesn't emit — the binary is the only source of truth.
#[test]
fn every_documented_cli_invocation_exists() {
    let mut offenders = BTreeSet::new();
    for doc in DOCS {
        for span in backticked(&read(doc)) {
            let Some((subcommands, flags)) = cli_invocation(&span) else {
                continue;
            };

            let mut path: Vec<&str> = Vec::new();
            let mut chain_broken = false;
            for subcommand in &subcommands {
                let help = help_output(&path);
                if !help_lists_command(&help, subcommand) {
                    let shown = if path.is_empty() {
                        "vibesync".to_string()
                    } else {
                        format!("vibesync {}", path.join(" "))
                    };
                    offenders.insert(format!(
                        "{doc}: `{span}` — {shown} has no `{subcommand}` subcommand"
                    ));
                    chain_broken = true;
                    break;
                }
                path.push(subcommand);
            }
            if chain_broken {
                continue;
            }

            let help = help_output(&path);
            for flag in &flags {
                let bare = flag.split('=').next().unwrap_or(flag);
                if !help_lists_option(&help, bare) {
                    offenders.insert(format!(
                        "{doc}: `{span}` — vibesync {} has no `{bare}` option",
                        path.join(" ")
                    ));
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "documented CLI invocations do not match the real binary:\n  {}",
        offenders.iter().cloned().collect::<Vec<_>>().join("\n  ")
    );
}
