# dynamic-qa brownfield vertical prototype

**Throwaway primary source — never merge this branch.**

Question: does the proposed state model make one brownfield workflow usable and pilotable—from Setup Inventory and QA interview through a repo-owned Flow Definition, Named Data Set, Boundary Declarations, tolerances, candidate Binding/provenance, advisory CI, one deterministic failure, diagnosis, and reviewable repair?

The scenario adopts and extends `tests/cli.rs::update_mode_also_archives_a_replaced_destination` as a candidate Binding. It models a deliberate Binding defect; it does not change or execute VibeFileSync product behavior and does not run a real pilot.

Run from the repository root:

```sh
cargo run --locked --example dynamic_qa_brownfield_prototype
```

Press the displayed key followed by Return. Every action replaces the frame and exposes the complete relevant state.
