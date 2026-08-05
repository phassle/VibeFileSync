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
//! Which documents are guarded is part of the guarantee, so `docs` discovers them rather
//! than naming them. An allowlist held the convention only where someone had remembered
//! to ask: three of this repo's own skills and an ADR carried `path:line` references for
//! as long as they did because they were never added to it, and their line numbers had
//! already drifted off the code they named by the time anyone looked.
//!
//! What it deliberately cannot check: whether a reference names the *right* symbol. An
//! anchor pointing at a real function that has nothing to do with the sentence around it
//! passes every check here — that happened on this very file, where the in-process render
//! seam was anchored to the CLI fixture instead of to the `TestBackend` helpers that
//! actually implement it. Existence is mechanical; aptness is a reading. Treat a green run
//! as "no reference is dangling", never as "the docs are accurate".

use assert_cmd::Command;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

/// The root guides, addressed by name because they are the only Markdown at the top
/// level this test governs.
const ROOT_GUIDES: &[&str] = &["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "README.md"];

/// A repository-owned skill is named for the product it operates: `build-vibesync`,
/// `test-vibesync`, `release-vibesync`. Everything else under `.agents/skills/` comes
/// from the upstream engineering bundle (`docs/dynamic-skills/README.md`).
const OWN_SKILL_SUFFIX: &str = "-vibesync";

/// The documents this repository owns, and which this test therefore governs.
///
/// Discovered, not listed. A hand-maintained list is opt-in, and opt-in is the hole:
/// `build-vibesync` and `test-vibesync` kept `path:line` references for as long as they
/// did precisely because nobody added them to the list, so the convention held only
/// where someone had remembered to ask for it. Under discovery a document is governed
/// from the moment it lands in one of these roots, and a new skill or ADR cannot arrive
/// unenforced.
///
/// The upstream skills are deliberately excluded rather than overlooked. They are
/// read-only here — replaced wholesale on reinstall — and their backticked spans are
/// templates addressed at whatever repository installs them (`MISSION.md`,
/// `0001-slug.md`), so checking them against *this* tree asks the wrong question.
fn docs() -> Vec<String> {
    let mut found: Vec<String> = ROOT_GUIDES.iter().map(|doc| doc.to_string()).collect();
    markdown_under(Path::new("docs"), &mut found);
    markdown_under(Path::new(".sandcastle"), &mut found);
    for skill in own_skills() {
        found.push(skill);
    }
    found.sort();
    found
}

fn own_skills() -> Vec<String> {
    let root = Path::new(".agents/skills");
    let Ok(entries) = fs::read_dir(repo_root().join(root)) else {
        return Vec::new();
    };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(OWN_SKILL_SUFFIX) {
            continue;
        }
        markdown_under(&root.join(name), &mut skills);
    }
    skills
}

/// Every Markdown file below `relative`, at any depth.
fn markdown_under(relative: &Path, into: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(repo_root().join(relative)) else {
        return;
    };
    for entry in entries.flatten() {
        let child = relative.join(entry.file_name());
        if entry.path().is_dir() {
            markdown_under(&child, into);
        } else if child.extension().is_some_and(|ext| ext == "md") {
            into.push(child.to_string_lossy().into_owned());
        }
    }
}

/// A span the docs write as a shape rather than as a reference: a placeholder segment
/// (`runs/<pair-name>/.lock`) or a glob (`tests/captures/*.txt`). Neither names one
/// file, so neither can be resolved — and a check that tried would only teach authors
/// to drop the backticks.
fn is_pattern(span: &str) -> bool {
    span.contains('<') || span.contains('*')
}

/// Whether `candidate` names a file in this repository.
///
/// A path with a directory in it claims a location, and is held to it. A bare filename
/// claims only a name — `SKILL.md` and `main.mts` are the kind of file, wherever it
/// lives — so it resolves against any file so named. That still catches the rot worth
/// catching: rename `main.mts` or mistype `Cargo.toml` and the reference fails. What it
/// does not do is demand a repository-root location that the prose never claimed.
fn resolves(candidate: &str) -> bool {
    if candidate.contains('/') {
        return repo_root().join(candidate).exists();
    }
    named_anywhere(Path::new("."), candidate)
}

fn named_anywhere(relative: &Path, name: &str) -> bool {
    let Ok(entries) = fs::read_dir(repo_root().join(relative)) else {
        return false;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        // `target/` is build output and `.git/` is history; neither is documentation's
        // subject, and both are large enough to be worth not walking.
        if matches!(
            file_name.to_string_lossy().as_ref(),
            "target" | ".git" | "node_modules"
        ) {
            continue;
        }
        if file_name == name {
            return true;
        }
        if entry.path().is_dir() && named_anywhere(&relative.join(file_name), name) {
            return true;
        }
    }
    false
}

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

/// Strips the modifiers that can stand between the start of a declaration and its
/// keyword, so `unsafe fn get_vol_attr` is as referenceable as `fn traverse`. Without
/// this the convention has a hole rather than a gap: the docs cannot name an `unsafe fn`
/// at all, and the check reports the apt reference as the broken one.
///
/// `const` is stripped only ahead of `fn`, because a bare `const NAME` is itself the
/// declaration.
fn without_modifiers(line: &str) -> &str {
    let mut head = line.strip_prefix("pub ").unwrap_or(line);
    head = head
        .split_once(") ")
        .filter(|_| line.starts_with("pub("))
        .map(|(_, tail)| tail)
        .unwrap_or(head);
    loop {
        let stripped = ["unsafe ", "async ", "extern \"C\" ", "default "]
            .iter()
            .find_map(|modifier| head.strip_prefix(modifier))
            .or_else(|| {
                head.strip_prefix("const ")
                    .filter(|tail| tail.starts_with("fn "))
            });
        match stripped {
            Some(tail) => head = tail,
            None => return head,
        }
    }
}

/// A Rust item declaration for `name`, however it is spelled.
fn declares(source: &str, name: &str) -> bool {
    source.lines().any(|line| {
        let line = line.trim_start();
        for keyword in [
            "fn ", "struct ", "enum ", "const ", "static ", "trait ", "type ", "mod ", "impl ",
            "union ",
        ] {
            let head = without_modifiers(line);
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

/// A modifier ahead of the keyword must not make an item unnameable — otherwise the
/// convention quietly excludes exactly the FFI and async seams most worth pointing at,
/// and the only reference that resolves is a worse one.
#[test]
fn declares_sees_through_the_modifiers_ahead_of_a_keyword() {
    let source = "\
unsafe fn get_vol_attr<T>() {}
pub(crate) async fn poll() {}
const fn width() -> usize { 0 }
const ATTR_VOL_UUID: u32 = 0;
    unsafe fn nested_in_an_impl() {}
";
    assert!(declares(source, "get_vol_attr"));
    assert!(declares(source, "poll"));
    assert!(declares(source, "width"));
    assert!(declares(source, "nested_in_an_impl"));
    // A bare `const` still declares its own name, not the keyword after it.
    assert!(declares(source, "ATTR_VOL_UUID"));
    assert!(!declares(source, "fn"));
    assert!(!declares(source, "unsafe"));
}

#[test]
fn docs_never_reference_code_by_line_number() {
    let mut offenders = BTreeSet::new();
    for doc in &docs() {
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
    for doc in &docs() {
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
    for doc in &docs() {
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
            if is_pattern(&span) {
                continue;
            }
            if !EXTENSIONS.iter().any(|ext| candidate.ends_with(ext)) {
                continue;
            }
            if !resolves(candidate) {
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
    for doc in &docs() {
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
    for doc in &docs() {
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
            } else if anchor.starts_with('#') {
                // A Markdown heading stands alone on its line too, so it resolves by the
                // same rule. Naming the heading is what lets a reference into a document
                // be as specific as a line number was without being positional: rename
                // the heading and this fails by name, move it and the reference follows.
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

/// Whether `token` documents an argument placeholder — `<pair>`, `<PATH>`, or
/// the bracketed-optional spelling `[<pair>]` — rather than a real subcommand
/// or flag. A placeholder can appear in its natural position (`status
/// <pair>`), not only after a flag, so it must be recognised on its own
/// shape, not merely by where it sits in the token stream.
fn is_placeholder(token: &str) -> bool {
    let inner = token
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(token);
    inner.starts_with('<') && inner.ends_with('>') && inner.len() > 1
}

/// Whether `token` names several subcommands at once — `add|list|remove` —
/// rather than one. This is the grammar-sketch spelling an ADR uses to show a
/// family of siblings in a single line; it names no single invocation, so
/// none can be resolved against `--help`, the same reasoning `is_pattern`
/// applies to a path written as a shape rather than a reference. Kept local
/// to the CLI-span path rather than folded into `is_pattern`, which serves
/// path resolution from different call sites.
fn is_alternation(token: &str) -> bool {
    token.contains('|')
}

/// The two spellings of "run this binary" the docs use, and the arguments each
/// carries. `vibesync <args>` is the installed binary; `cargo run --locked --
/// <args>` is the development fallback the skill documents beside nearly every
/// command, and the `--` separator means the same arguments follow it verbatim.
///
/// Recognising only the first spelling left the second unchecked, which made the
/// fallback lines the one place in the docs where a typo could ship: they are
/// prose to this test but a command to whoever pastes them. The prefix is matched
/// whole and exactly, so the neighbouring `cargo build --locked` and a bare
/// `cargo run --locked` — real commands that take no vibesync arguments — still
/// name no invocation.
const BINARY_SPELLINGS: &[&[&str]] = &[&["vibesync"], &["cargo", "run", "--locked", "--"]];

/// The arguments a span passes to the binary, or `None` if the span does not
/// invoke it at all. An empty argument list is `None` too: `` `vibesync` `` and
/// `` `cargo run --locked --` `` name the binary rather than an invocation of it,
/// and there is nothing in either to resolve.
fn invocation_arguments(span: &str) -> Option<Vec<&str>> {
    let tokens: Vec<&str> = span.split_whitespace().collect();
    let arguments = BINARY_SPELLINGS.iter().find_map(|spelling| {
        (tokens.len() > spelling.len() && &tokens[..spelling.len()] == *spelling)
            .then(|| tokens[spelling.len()..].to_vec())
    })?;
    Some(arguments)
}

/// The subcommand path and `--flag`s of a documented invocation, in either
/// spelling (`BINARY_SPELLINGS`).
/// Subcommands are the leading run of tokens before the first token that is
/// either a flag or a placeholder; flags are every later token that itself
/// starts with `-`. A placeholder is never treated as a subcommand — whether
/// it sits after a flag (documenting the flag's argument) or in its natural
/// position (documenting a positional, e.g. `status <pair>`) — and never as a
/// flag either. `None` for a span that isn't an invocation at all —
/// most backticked spans are paths or symbols, not commands — and also for a
/// span whose subcommand position is written as alternation: it names a
/// grammar shape, not one invocation, so there is nothing here to resolve.
fn cli_invocation(span: &str) -> Option<(Vec<&str>, Vec<&str>)> {
    let tokens = invocation_arguments(span)?;
    let split = tokens
        .iter()
        .position(|token| token.starts_with('-') || is_placeholder(token))
        .unwrap_or(tokens.len());
    let (subcommands, rest) = tokens.split_at(split);
    if subcommands.iter().any(|token| is_alternation(token)) {
        return None;
    }
    let flags: Vec<&str> = rest
        .iter()
        .copied()
        .filter(|token| token.starts_with('-'))
        .collect();
    Some((subcommands.to_vec(), flags))
}

/// The two spellings must resolve to the same invocation, or the fallback lines
/// are documentation this test only appears to check. Pinning the negative half
/// matters as much: the prefix is `cargo run --locked --` exactly, and the
/// neighbouring `cargo` commands must keep naming nothing.
#[test]
fn cli_invocation_reads_both_spellings_of_the_binary() {
    let installed = cli_invocation("vibesync pair list --check");
    let fallback = cli_invocation("cargo run --locked -- pair list --check");
    assert_eq!(installed, Some((vec!["pair", "list"], vec!["--check"])));
    assert_eq!(fallback, installed);

    // The placeholder rule travels with the arguments, not with the spelling.
    assert_eq!(
        cli_invocation("cargo run --locked -- run <pair> --exclude <PATH>"),
        Some((vec!["run"], vec!["--exclude"]))
    );
    // So does the alternation escape hatch.
    assert_eq!(
        cli_invocation("cargo run --locked -- pair add|list|remove"),
        None
    );

    // Not this binary, or not an invocation of it.
    assert_eq!(cli_invocation("cargo build --locked"), None);
    assert_eq!(cli_invocation("cargo run --locked"), None);
    assert_eq!(cli_invocation("cargo run -- pair list"), None);
    assert_eq!(cli_invocation("cargo test --locked -- pair list"), None);
    assert_eq!(cli_invocation("src/cli.rs::Command"), None);
    // The binary named rather than invoked: nothing to resolve either way.
    assert_eq!(cli_invocation("vibesync"), None);
    assert_eq!(cli_invocation("cargo run --locked --"), None);
}

/// A fenced block's commands must arrive as one span each, with everything a
/// shell line carries and an invocation does not stripped off. Without this the
/// quickstart's whole CLI surface reads as a single opaque span and none of it is
/// checked.
#[test]
fn command_spans_reads_fenced_blocks_line_by_line() {
    let doc = "\
Prose naming `docs/quickstart.md`.

```bash
cargo build --locked          # dev binary
# a comment-only line
$ vibesync pair list --check
cargo run --locked -- pair add <name> \\
  --source <PATH> \\
  --mode mirror   # or: update
```

Prose again.
";
    let spans = command_spans(doc);
    assert!(spans.contains(&"vibesync pair list --check".to_string()));
    assert!(spans.contains(
        &"cargo run --locked -- pair add <name> --source <PATH> --mode mirror".to_string()
    ));
    assert!(spans.contains(&"cargo build --locked".to_string()));
    // The inline spans the other checks read are still there, unchanged.
    assert!(spans.contains(&"docs/quickstart.md".to_string()));
    // A comment-only line is not a command.
    assert!(!spans.iter().any(|span| span.starts_with('#')));
    // Prose outside the fence is not a command line.
    assert!(!spans.iter().any(|span| span.contains("Prose")));
}

/// A trailing `# …` comment, removed. Anchored to a `#` that opens a word, so a
/// `#` inside an argument is left alone; a comment-only line becomes empty and is
/// dropped by the caller.
fn without_comment(line: &str) -> &str {
    match line.find('#') {
        Some(at) if at == 0 || line[..at].ends_with(char::is_whitespace) => &line[..at],
        _ => line,
    }
}

/// The shell prompt a transcript-style example writes ahead of the command,
/// removed. `$ vibesync run <pair>` documents the same invocation as
/// `vibesync run <pair>`, and a parser that saw only the second would treat the
/// first as prose.
fn without_prompt(line: &str) -> &str {
    ["$ ", "% ", "> "]
        .iter()
        .find_map(|prompt| line.strip_prefix(prompt))
        .unwrap_or(line)
}

/// Every span a document offers as a command line: its inline `` `…` `` spans,
/// plus each command inside a fenced code block.
///
/// A fenced block is where a quickstart naturally writes its commands, and
/// `backticked` sees a whole block as one opaque span beginning with the language
/// tag — so `docs/quickstart.md` documented the entire CLI surface without a
/// single line of it being checked. Reading the block line by line closes that,
/// at the cost of teaching the parser what a shell line can carry that a
/// backticked span never does: a prompt, a trailing comment, and a `\`
/// continuation. Lines are joined across continuations before being handed on, so
/// a command split over four lines resolves as the one invocation it is; anything
/// that is not an invocation of this binary falls out in `cli_invocation`.
///
/// Deliberately separate from `backticked` rather than folded into it. The path,
/// symbol and section checks read `backticked` too, and they ask a different
/// question of a span — feeding them the contents of every fenced Rust and JSON
/// block would have them resolving code and sample output as if it were prose
/// naming a file.
fn command_spans(doc: &str) -> Vec<String> {
    let mut spans = backticked(doc);
    let mut in_fence = false;
    let mut continued = String::new();
    for line in doc.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continued.clear();
            continue;
        }
        if !in_fence {
            continue;
        }
        let line = without_prompt(without_comment(line).trim()).trim();
        if line.is_empty() {
            continue;
        }
        match line.strip_suffix('\\') {
            Some(head) => {
                continued.push_str(head.trim_end());
                continued.push(' ');
            }
            None => {
                let mut whole = std::mem::take(&mut continued);
                whole.push_str(line);
                spans.push(whole);
            }
        }
    }
    spans
}

/// `vibesync <path> --help`'s stdout, run against the real built binary —
/// never a glob engine or a hand-maintained list of flags.
fn help_output(path: &[&str]) -> String {
    let mut cmd = Command::cargo_bin("vibesync").expect("binary builds");
    cmd.args(path).arg("--help");
    let output = cmd.output().expect("vibesync --help runs");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// One `--help` per distinct subcommand path, not per span that names it. The
/// docs invoke a handful of paths over and over — once in each spelling for most
/// commands, and again in the quickstart — and every repeat is a process spawn.
/// The cache holds output, never a verdict: what `--help` says is still read
/// fresh for each span, so nothing here can turn a failing span into a passing one.
#[derive(Default)]
struct HelpCache(BTreeMap<Vec<String>, String>);

impl HelpCache {
    fn new() -> Self {
        Self::default()
    }

    fn get(&mut self, path: &[&str]) -> &str {
        let key: Vec<String> = path.iter().map(|part| part.to_string()).collect();
        self.0.entry(key).or_insert_with(|| help_output(path))
    }
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

/// Every invocation `text` shows that the real binary does not expose, reported
/// as `doc` named it.
///
/// Taking the document's text as an argument rather than reading it from `doc` is
/// what makes this check's own ability to fail testable: a sabotaged document can
/// be handed to it in memory, with no file to mutate and revert. That was
/// previously an out-of-tree shell script, which meant the one guarantee standing
/// between the docs and a flag the binary does not expose was itself unguarded —
/// and a refactor that quietly made the check unable to fail would have passed
/// the suite.
fn unresolved_invocations(doc: &str, text: &str, helps: &mut HelpCache) -> BTreeSet<String> {
    let mut offenders = BTreeSet::new();
    for span in command_spans(text) {
        let Some((subcommands, flags)) = cli_invocation(&span) else {
            continue;
        };

        let mut path: Vec<&str> = Vec::new();
        let mut chain_broken = false;
        for subcommand in &subcommands {
            let help = helps.get(&path);
            if !help_lists_command(help, subcommand) {
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

        let help = helps.get(&path);
        for flag in &flags {
            let bare = flag.split('=').next().unwrap_or(flag);
            if !help_lists_option(help, bare) {
                offenders.insert(format!(
                    "{doc}: `{span}` — vibesync {} has no `{bare}` option",
                    path.join(" ")
                ));
            }
        }
    }
    offenders
}

/// Every documented invocation an agent doc shows — inline-backtick or fenced,
/// installed binary or development fallback (`BINARY_SPELLINGS`) — must resolve
/// against the real binary's own `--help`: each subcommand it names must be
/// listed at that level, and each `--flag` it passes must be listed on that
/// exact invocation's help. No glob engine, no invented flags, no exit-code
/// strings the binary doesn't emit — the binary is the only source of truth.
#[test]
fn every_documented_cli_invocation_exists() {
    let mut offenders = BTreeSet::new();
    let mut helps = HelpCache::new();
    for doc in &docs() {
        offenders.extend(unresolved_invocations(doc, &read(doc), &mut helps));
    }
    assert!(
        offenders.is_empty(),
        "documented CLI invocations do not match the real binary:\n  {}",
        offenders.iter().cloned().collect::<Vec<_>>().join("\n  ")
    );
}

/// A green `every_documented_cli_invocation_exists` must mean the docs match the
/// binary, not that the check stopped looking. Each case below is a way the docs
/// could name something the binary does not expose, in each spelling and from
/// each span source, and each must be reported — so widening the parser, adding a
/// skip rule, or teaching a helper to swallow a token cannot silently make the
/// check unable to fail.
///
/// This runs against the real binary's `--help`, exactly as the check does; only
/// the document is synthetic.
#[test]
fn the_cli_check_still_reports_what_the_binary_does_not_expose() {
    // (case, document text, the offender it must name)
    let sabotage = [
        (
            "misspelled top-level subcommand",
            "Run `vibesync stauts <pair>` afterwards.",
            "vibesync has no `stauts` subcommand",
        ),
        (
            "unknown flag",
            "Run `vibesync run <pair> --nope` afterwards.",
            "vibesync run has no `--nope` option",
        ),
        (
            // `pair list`/`pair add`/`pair remove` are genuine two-token
            // subcommands, so the chain has to resolve level by level.
            "misspelled nested subcommand",
            "Run `vibesync pair lst` afterwards.",
            "vibesync pair has no `lst` subcommand",
        ),
        (
            "fallback: misspelled top-level subcommand",
            "Development fallback: `cargo run --locked -- stauts <pair>`",
            "vibesync has no `stauts` subcommand",
        ),
        (
            "fallback: unknown flag",
            "Development fallback: `cargo run --locked -- run <pair> --nope`",
            "vibesync run has no `--nope` option",
        ),
        (
            "fallback: misspelled nested subcommand",
            "Development fallback: `cargo run --locked -- pair lst`",
            "vibesync pair has no `lst` subcommand",
        ),
        (
            "fenced, with a prompt",
            "```bash\n$ vibesync pair lst\n```",
            "vibesync pair has no `lst` subcommand",
        ),
        (
            "fenced fallback, with a trailing comment",
            "```bash\ncargo run --locked -- run <pair> --nope   # trailing comment\n```",
            "vibesync run has no `--nope` option",
        ),
        (
            "fenced, split over a continuation",
            "```bash\ncargo run --locked -- pair add <pair> \\\n  --source <PATH> \\\n  --nope\n```",
            "vibesync pair add has no `--nope` option",
        ),
    ];

    let mut helps = HelpCache::new();
    for (case, text, expected) in sabotage {
        let offenders = unresolved_invocations("sabotage.md", text, &mut helps);
        assert!(
            offenders.iter().any(|offender| offender.contains(expected)),
            "the CLI check no longer reports {case}: expected an offender naming \
             \"{expected}\", got {offenders:?}"
        );
    }

    // The other half of the guarantee: a check that fails on everything is no
    // check either. The real spellings, the placeholders and the alternation
    // sketch must all stay silent.
    let legitimate = "\
`vibesync pair list --check` and `cargo run --locked -- pair list --check`,
`vibesync run <pair> --yes --exclude <PATH>`, `vibesync tui [<pair>]`,
the grammar sketch `vibesync pair add|list|remove`, the bare `vibesync`,
and a fenced block:

```bash
cargo build --locked          # not this binary
$ vibesync history <pair> --json
```
";
    let offenders = unresolved_invocations("control.md", legitimate, &mut helps);
    assert!(
        offenders.is_empty(),
        "the CLI check reports legitimate documentation: {offenders:?}"
    );

    // And the check must still be pointed at real documents. Everything above
    // holds on synthetic text, so it would keep passing if `docs()` stopped
    // discovering anything or the repository's own invocations stopped parsing —
    // leaving `every_documented_cli_invocation_exists` green over nothing.
    let documents_naming_an_invocation = docs()
        .iter()
        .filter(|doc| {
            command_spans(&read(doc))
                .iter()
                .any(|span| cli_invocation(span).is_some())
        })
        .count();
    assert!(
        documents_naming_an_invocation >= 2,
        "only {documents_naming_an_invocation} governed document(s) parse as naming an \
         invocation — the CLI check has nothing left to resolve"
    );
}
