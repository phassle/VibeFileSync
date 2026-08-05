mod model;

use model::{Action, PrototypeState, RepairDecision, Stage};
use std::io::{self, IsTerminal, Write};

const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const RESET: &str = "\x1b[0m";

fn main() {
    let interactive = io::stdin().is_terminal() && io::stdout().is_terminal();
    let mut state = PrototypeState::default();

    loop {
        render(&state, interactive);
        if state.stage == Stage::Reaction {
            break;
        }

        print!("> ");
        io::stdout().flush().unwrap();
        let mut input = String::new();
        if io::stdin().read_line(&mut input).unwrap() == 0 {
            break;
        }
        let action = match input.trim() {
            "n" => Action::Advance,
            "f" => Action::Fail,
            "d" => Action::Diagnose,
            "p" => Action::ProposeRepair,
            "a" => Action::Accept,
            "e" => Action::Edit,
            "j" => Action::Reject,
            "r" => Action::Reset,
            "q" => break,
            _ => {
                pause("unknown key", interactive);
                continue;
            }
        };
        match state.apply(action) {
            Ok(next) => state = next,
            Err(message) => pause(message, interactive),
        }
    }
}

fn render(state: &PrototypeState, clear: bool) {
    if clear {
        print!("\x1b[2J\x1b[H");
    }
    println!("{BOLD}dynamic-qa brownfield vertical — THROWAWAY PROTOTYPE{RESET}");
    println!("{DIM}Question: does this setup → deterministic CI → reviewed repair lifecycle feel usable and pilotable?{RESET}\n");
    println!("{BOLD}Pilot{RESET}");
    field("Application", "VibeFileSync");
    field("Responsible QA Owner", "Per");
    field(
        "Environment",
        "GitHub-hosted macos-14; isolated temporary trees; no secrets/network/external volumes",
    );
    field(
        "Critical flow",
        "Update preserves the prior destination version in SafetyNet before Publish",
    );
    field("Stage", stage_name(state.stage));
    println!();

    match state.stage {
        Stage::SetupInventory => inventory(),
        Stage::FlowContract => flow_contract(),
        Stage::CandidateBinding => candidate_binding(),
        Stage::AdvisoryCi => advisory_ci(),
        Stage::DeterministicFailure => deterministic_failure(state.failure_reproductions),
        Stage::Diagnosis => diagnosis(state.failure_reproductions),
        Stage::RepairReview => repair_review(),
        Stage::Reaction => reaction(state.repair_decision.unwrap()),
    }
    println!();
    shortcuts(state.stage);
}

fn inventory() {
    section("Setup Inventory + QA interview result");
    field("Harness", "Rust integration tests via cargo test");
    field("CI provider", "GitHub Actions; pull_request → develop/main");
    field(
        "Existing CI",
        "cargo test --locked --features fault-injection --test acceptance",
    );
    field(
        "Candidate evidence",
        "tests/cli.rs::update_mode_also_archives_a_replaced_destination",
    );
    field(
        "CI gap",
        "the existing candidate is not executed by the current acceptance workflow",
    );
    field(
        "Named-flow coverage",
        "0/1 in PR CI; 1 candidate test exists locally",
    );
    field(
        "PR-check p95",
        "8m37s; 34 completed acceptance runs, 2026-08-01..2026-08-05 UTC",
    );
    field("Other baselines", "not instrumented: escaped regressions, flaky/false positives, maintenance time, repair outcomes");
}

fn flow_contract() {
    section("Flow Definition — qa/flows/update-preserves-safetynet.yaml");
    println!("id: update-preserves-safetynet");
    println!("revision: 1");
    println!("origin: https://github.com/phassle/VibeFileSync/issues/18");
    println!("given: Folder pair 'documents' uses Update with changed-destination data");
    println!("when: the QA Owner reviews Compare and approves Run");
    println!("then:");
    println!("  - destination report.txt contains 'new version'");
    println!("  - exactly one SafetyNet Run folder contains report.txt = 'old version'");
    println!("  - no sibling temp remains");
    println!("tolerances:");
    println!("  - Run id varies but matches YYYYMMDDTHHMMSSZ");
    println!("named_data: changed-destination");
    println!("boundaries:");
    println!("  real: [vibesync CLI, temporary APFS filesystem, run clock]");
    println!("  simulated: []");
    println!("  forbidden: [production paths, user HOME, external volumes, network]");
}

fn candidate_binding() {
    section("Candidate Binding + provenance");
    field(
        "Chosen level",
        "CLI integration; lowest level proving the filesystem-visible contract",
    );
    field(
        "Adopt + extend",
        "tests/cli.rs::update_mode_also_archives_a_replaced_destination",
    );
    field(
        "Command",
        "cargo test --locked --test cli update_mode_also_archives_a_replaced_destination -- --exact",
    );
    field("Flow revision", "update-preserves-safetynet@1");
    field(
        "Originating ticket",
        "VibeFileSync SafetyNet implementation — issue 18",
    );
    field("Generator", "dynamic-qa prototype/adopt-existing@0");
    field(
        "Manifest",
        "qa/provenance.json → flow, revision, ticket, level, generator, generated file + symbol",
    );
    field(
        "Drift gate",
        "fail if the recorded flow revision or Binding digest differs; no AI required",
    );
}

fn advisory_ci() {
    section("Brownfield advisory CI");
    field("Required status", "false during burn-in");
    field("Runtime AI", "none");
    field("Permission", "contents: read");
    field("Runner", "macos-14");
    field(
        "Command",
        "targeted deterministic cargo test from the candidate Binding",
    );
    field(
        "Evidence",
        "JUnit result + scrubbed artifact tree + command/version metadata",
    );
    field(
        "Promotion",
        "QA Owner explicitly promotes only after thresholds pass",
    );
}

fn deterministic_failure(reproductions: u8) {
    section("Deterministic advisory failure");
    field("Result", "FAILED; remains red");
    field(
        "Reproductions",
        &format!("{reproductions}/{reproductions} identical isolated runs"),
    );
    field(
        "Failure",
        "Binding searched _SafetyNet/report.txt; file exists under _SafetyNet/<Run id>/report.txt",
    );
    field(
        "Observed product",
        "destination is new; exactly one Run folder preserves old; no temp remains",
    );
    field("Flow revision", "unchanged: update-preserves-safetynet@1");
    field(
        "Automatic action",
        "none — diagnose before proposing any patch",
    );
}

fn diagnosis(reproductions: u8) {
    section("Diagnosis");
    field(
        "Repeatability",
        &format!("confirmed ({reproductions}/{reproductions})"),
    );
    field("Causal owner", "Binding defect");
    field(
        "Reason",
        "the product satisfies every declared outcome; the Binding flattened the Run folder",
    );
    field(
        "Repair allowed",
        "yes: narrow path traversal in generated test code",
    );
    field(
        "Repair forbidden",
        "changing expectations/tolerance/boundaries, quarantining, or making CI green",
    );
    field(
        "CI state",
        "still failed until a reviewed patch lands and deterministic CI reruns",
    );
}

fn repair_review() {
    section("Diagnose-before-repair proposal");
    println!("- archive = destination/_SafetyNet/report.txt");
    println!("+ run_folders = sorted_directories(destination/_SafetyNet)");
    println!("+ assert exactly_one(run_folders)");
    println!("+ archive = run_folders[0]/report.txt");
    println!();
    field("Flow Definition", "unchanged");
    field("Tolerance", "unchanged");
    field("Boundary policy", "unchanged");
    field("Quarantine/required check", "unchanged");
    field(
        "Provenance",
        "Binding digest changes; generator + review decision appended",
    );
}

fn reaction(decision: RepairDecision) {
    section("Per's prototype reaction");
    field(
        "Repair proposal",
        match decision {
            RepairDecision::AcceptedUnchanged => "accepted unchanged",
            RepairDecision::NeedsEdit => "edit requested",
            RepairDecision::Rejected => "rejected",
        },
    );
    field(
        "Next",
        "tell the wayfinding session what felt wrong or right; the real pilot has not run",
    );
}

fn shortcuts(stage: Stage) {
    let keys = match stage {
        Stage::SetupInventory | Stage::FlowContract | Stage::CandidateBinding => "[n] next",
        Stage::AdvisoryCi => "[f] run the deliberately failing Binding",
        Stage::DeterministicFailure => "[d] diagnose",
        Stage::Diagnosis => "[p] propose repair",
        Stage::RepairReview => "[a] accept  [e] request edit  [j] reject",
        Stage::Reaction => "",
    };
    if !keys.is_empty() {
        println!("{BOLD}{keys}{RESET}  {DIM}[r] reset  [q] quit{RESET}");
    }
}

fn section(name: &str) {
    println!("{BOLD}{name}{RESET}");
}

fn field(name: &str, value: &str) {
    println!("{BOLD}{name}:{RESET} {value}");
}

fn stage_name(stage: Stage) -> &'static str {
    match stage {
        Stage::SetupInventory => "1/7 Setup Inventory",
        Stage::FlowContract => "2/7 Flow contract",
        Stage::CandidateBinding => "3/7 Candidate Binding",
        Stage::AdvisoryCi => "4/7 Advisory CI",
        Stage::DeterministicFailure => "5/7 Deterministic failure",
        Stage::Diagnosis => "6/7 Diagnosis",
        Stage::RepairReview => "7/7 Repair review",
        Stage::Reaction => "Reaction captured",
    }
}

fn pause(message: &str, interactive: bool) {
    eprintln!("{message}");
    if interactive {
        eprintln!("press Enter");
        let mut ignored = String::new();
        io::stdin().read_line(&mut ignored).unwrap();
    }
}
