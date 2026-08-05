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

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// The root guides, addressed by name because they are the only Markdown at the top
/// level this test governs.
const ROOT_GUIDES: &[&str] = &["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "README.md"];

/// A repository-owned skill is named for the product it operates: `build-vibesync`,
/// `test-vibesync`, `release-vibesync`. Everything else under `.agents/skills/` comes
/// from the upstream engineering bundle (`docs/dynamic-skills/README.md`).
const OWN_SKILL_SUFFIX: &str = "-vibesync";

/// Build output, history, and installed packages. None is documentation's subject, and
/// each is large enough that walking it would dominate the cost of this suite.
const UNWALKED: &[&str] = &["target", ".git", "node_modules"];

/// What one walk of the repository tells this suite: which documents it governs, and
/// every filename present. Both answers come from the same traversal, taken once —
/// every check below reads it, and resolving a bare filename asks it a question rather
/// than re-walking to answer.
struct Tree {
    docs: Vec<String>,
    file_names: BTreeSet<String>,
}

fn tree() -> &'static Tree {
    static TREE: OnceLock<Tree> = OnceLock::new();
    TREE.get_or_init(|| {
        let mut paths = Vec::new();
        walk(Path::new(""), &mut paths);
        let mut docs: Vec<String> = paths
            .iter()
            .filter(|path| governed(path))
            .cloned()
            .collect();
        docs.sort();
        let file_names = paths
            .iter()
            .filter_map(|path| path.rsplit('/').next().map(str::to_string))
            .collect();
        Tree { docs, file_names }
    })
}

/// Whether this repository owns `path` as documentation, and this test therefore
/// governs it.
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
fn governed(path: &str) -> bool {
    if ROOT_GUIDES.contains(&path) {
        return true;
    }
    if !path.ends_with(".md") {
        return false;
    }
    if path.starts_with("docs/") || path.starts_with(".sandcastle/") {
        return true;
    }
    path.strip_prefix(".agents/skills/")
        .and_then(|tail| tail.split_once('/'))
        .is_some_and(|(skill, _)| skill.ends_with(OWN_SKILL_SUFFIX))
}

/// Every file below `relative`, at any depth, as a repository-relative slash path.
fn walk(relative: &Path, into: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(repo_root().join(relative)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if UNWALKED.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let child = relative.join(name);
        if entry.path().is_dir() {
            walk(&child, into);
        } else {
            into.push(child.to_string_lossy().replace('\\', "/"));
        }
    }
}

fn docs() -> &'static [String] {
    &tree().docs
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
    tree().file_names.contains(candidate)
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
    for doc in docs() {
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
    for doc in docs() {
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
    for doc in docs() {
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
    for doc in docs() {
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
    for doc in docs() {
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
