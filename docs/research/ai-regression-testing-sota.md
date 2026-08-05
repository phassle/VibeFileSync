# Research: AI-generated regression testing and agentic E2E testing

## Question

What exists today for AI-driven regression-test generation and agentic
end-to-end (E2E) testing — commercial tools, open-source frameworks, and
self-healing test approaches? What actually works, what fails, and which
capabilities should the planned `dynamic-qa` bundle borrow, wrap, or
deliberately avoid rebuilding? Cover browser-level tooling (Playwright codegen
and AI test agents, plus commercial agentic browser testers), API-level
tooling, tech-neutral/cross-stack offerings, and self-healing locator
approaches with their known failure modes. Filed as issue #97, part of the
`dynamic-qa` initiative tracked in #95.

## Primary-source findings

### Browser-level: Playwright's own AI tooling

Playwright ships three layers, from deterministic to agentic:

* **Codegen is deterministic, not AI.** The official docs describe it as
  recording browser actions and generating locators that "prioritiz[e] role,
  text, and test id" — pure DOM analysis, with no LLM involved
  ([Generating tests](https://playwright.dev/docs/codegen-intro),
  [Test generator](https://playwright.dev/docs/codegen)). Its only
  documented self-repair behavior is compile-time locator disambiguation when
  multiple elements match, not runtime healing.
* **Playwright MCP is the agent-facing browser driver.** `@playwright/mcp`
  (Microsoft, Apache-2.0) exposes browser control as MCP tools and represents
  pages as structured accessibility-tree snapshots by default rather than
  screenshots, which the project states makes it faster, more deterministic,
  and independent of vision models. A vision mode (coordinate-based clicks)
  is opt-in for cases the accessibility tree can't resolve
  ([microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)).
  The project explicitly states it "is **not** a security boundary" and
  positions itself for "exploratory automation, self-healing tests, or
  long-running autonomous workflows" rather than high-throughput scripted
  runs.
* **Playwright Test Agents (v1.56+, October 2025) are the first-party
  agentic-authoring layer**: Planner, Generator, and Healer, usable
  independently, sequentially, or in a loop
  ([Test Agents](https://playwright.dev/docs/test-agents)).
  * *Planner* explores the app using a seed test to bootstrap fixtures/global
    setup, then writes a Markdown test plan to `specs/` — "human-readable but
    precise enough for test generation."
  * *Generator* turns that Markdown plan into an executable Playwright test
    file, verifying selectors and assertions live against the running app as
    it writes them.
  * *Healer* replays a failing test's steps, inspects current UI state to
    find an equivalent element or flow, and proposes a patch (locator, wait,
    or data fix); it runs under "guardrails" that cap repair iterations rather
    than healing indefinitely.
  * Setup is `npx playwright init-agents --loop=[vscode|claude|codex|opencode]`,
    generating agent definitions tied to the installed Playwright version that
    must be regenerated on upgrade — i.e., the agents are prompt/tooling
    scaffolding on top of Playwright, not a separately versioned product.

This is directly relevant prior art: Playwright's own three-role split
(Planner → Generator → Healer) is structurally the same shape `dynamic-qa`
needs (QA-authored flow → generated test → maintenance), except Playwright's
Planner explores the app itself rather than taking human-authored flows as
authoritative input.

### Browser-level: commercial agentic testers

Verified against each vendor's own site/docs rather than roundup posts:

* **QA Wolf** converts a plain-language flow description into "production-grade
  Playwright and Appium code" that customers own and can edit/version — not a
  recording or a computer-use trace — explicitly framed as deterministic:
  "identical behavior on every run, no hallucinations, no variable paths"
  ([Welcome to QA Wolf](https://docs.qawolf.com/qawolf/Welcome-to-QA-Wolf)).
  It also runs tests on its own infrastructure, triggerable from customer CI.
  This "generate reviewable code the customer keeps" posture is close to what
  `dynamic-qa` wants (tech-neutral generation + customer's own CI), though QA
  Wolf's own output is still Playwright/Appium, not framework-agnostic.
* **mabl auto-heal** captures a multi-attribute "element model" per recorded
  step and, on locator failure, searches for the best partial match against
  that model; if standard matching fails, cloud runs escalate to "advanced
  auto-healing" that uses generative AI to match on semantic/text similarity
  rather than only structural attributes
  ([How auto-heal works](https://help.mabl.com/hc/en-us/articles/19078583792404-How-auto-heal-works)).
* **Tricentis Testim** (Testim acquired by Tricentis, Feb 2022) locates
  elements via stable identifiers even after ID/class changes, and separately
  detects UI changes to *propose* test updates for one-click human review
  rather than always healing silently
  ([acquisition announcement](https://www.tricentis.com/news/tricentis-acquires-ai-based-saas-test-automation-platform-testim)).
* **Katalon** runs two tiers: *classic* self-healing retries a prioritized
  list of pre-recorded alternative locators (XPath, attributes, CSS, image,
  "Smart Locator"); only if all of those fail does *AI* self-healing invoke an
  LLM against page source, the accessibility tree, and screenshots to propose
  a new locator. Katalon's own docs flag a known gap: "AI self-healing might
  have issues finding the element with the image locator. This module will be
  improved in upcoming releases"
  ([Self-healing tests in Katalon Studio](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio)).
* **Reflect** generates steps from natural-language prompts or recording, and
  falls back to its "AI Assistant" to relocate an element when the original
  selector no longer matches
  ([Test with AI](https://reflect.run/docs/recording-tests/testing-with-ai/)).
* **Momentic** describes its "V3 agent" as planning the flow up front, caching
  resolved steps, and self-healing only on failure; its CLI separates concerns
  usefully — `momentic ai explore` maps a git diff to affected user journeys,
  `momentic results check` gates CI on non-quarantined runs, and
  `momentic ai triage` clusters failures and can auto-quarantine what it can't
  fix (per Momentic's own site, momentic.ai). The explore→generate,
  gate-on-results, triage-and-quarantine split is a useful CI-integration
  pattern independent of Momentic's own implementation.
* **Rainforest QA** combines an "AI test planner" that scans the product for
  coverage gaps with human-crowdtesting execution across 40+ browser/OS
  combinations, and drafts human-readable no-code tests from a single prompt
  (rainforestqa.com). It's the one surveyed tool that pairs AI generation with
  a *human* execution/verification layer rather than pure automation — a
  useful HITL precedent, though its output format is Rainforest's own
  no-code steps, not portable test code.
* **Autify** advertises self-healing selectors and, for mobile, "Intelligent
  Screen Recognition" instead of DOM locators, plus a "Genesis" test-case
  generation product (autify.com); vendor claims a large maintenance-time
  reduction but the mechanism detail available from the vendor's own material
  is thinner than mabl's or Katalon's.
* **testRigor** and **Virtuoso QA** are the two vendors explicitly built around
  plain-English authoring rather than recorded/generated code. testRigor
  claims a single script executed across web, mobile (native/hybrid,
  iOS/Android), desktop, API, email, SMS, and 2FA
  ([testRigor docs](https://testrigor.com/docs/)); Virtuoso QA combines NLP
  authoring with a claimed "95% self-healing accuracy" and validates UI, API,
  and database steps in one journey (virtuosoqa.com). These are the closest
  existing analogues to "describe a flow at the business level, run it
  cross-stack" — but both are closed, hosted platforms: the tech-neutral
  representation lives inside their proprietary runtime, not as a portable
  spec a customer's own CI can execute.

### API-level: AI-assisted generation, not autonomous authoring

* **Postman Agent Mode** observes real request/response traffic in the
  workspace (ID formats, enum values, timestamp shapes) and generates
  standard, plain-JavaScript Postman test scripts from that context plus a
  natural-language instruction — explicitly built to need no special runtime:
  the output "runs in Collection Runner, CLI, and CI/CD without any special
  runtime"
  ([Testing APIs with Postman Agent Mode](https://blog.postman.com/testing-apis-with-postman-agent-mode-a-practical-guide/)).
  It also does diagnostic work (e.g., explaining an auth failure by reading
  headers/token expiry) rather than only generating assertions.
* **Spec-to-test generation is a separate, more mechanical lineage** that
  predates the current AI wave and is not itself AI-driven: converters take an
  OpenAPI/Swagger spec and emit a Postman collection with generated contract
  checks (status code, content-type, schema, response time). **Portman**
  (open source) generates three explicit test tiers from one config — contract
  tests (schema/status/timing), variation tests (error-path probing), and
  integration tests (chained requests with variable extraction)
  ([apideck-libraries/portman](https://github.com/apideck-libraries/portman)).
  This is a good template for "compile a declared contract into deterministic
  checks" even though it isn't itself LLM-based — the generation logic is
  spec-shape-driven, which is exactly the kind of narrow, well-understood
  problem `dynamic-qa` should not reinvent with an LLM.

### Tech-neutral / cross-stack: rare, and always vendor-hosted

No project in this survey ships an open, portable *format* for "business-level
flow → compiled to multiple technical backends" the way `dynamic-qa` intends.
The closest analogues are hosted, closed platforms (testRigor, Virtuoso QA,
Rainforest QA) whose plain-English or NLP layer is proprietary and whose
execution stays inside their own cloud — a customer cannot take the
intermediate representation and run it in their own CI without the vendor's
runtime. Playwright's Planner is the one first-party counter-example of an
*open* intermediate representation (a Markdown test plan under version
control), but it only compiles to one backend (Playwright itself), and the
"business flow" input is generated by the Planner exploring the app rather
than authored upfront by a QA expert.

### Self-healing: what actually happens, and where it fails

**Mechanism, by vendor's own description:**

| Tool | Primary signal | Escalation path |
| --- | --- | --- |
| mabl | Recorded per-element attribute model, partial-match scoring | Generative-AI semantic match in cloud runs when structural matching is unsure ([source](https://help.mabl.com/hc/en-us/articles/19078583792404-How-auto-heal-works)) |
| Katalon | Prioritized list of alternate pre-recorded locators (XPath/attrs/CSS/image/Smart) | LLM reads page source + accessibility tree + screenshots only if all alternates fail ([source](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio)) |
| Healenium (OSS) | DOM-tree similarity scoring against a stored locator history | None documented beyond ML similarity; Playwright support is explicitly less mature than its Selenium support as of 2025–2026 ([healenium GitHub org](https://github.com/healenium)) |
| Functionize | Multi-dimensional "5D" element fingerprint plus time-series drift tracking, with a reverse-validation ("adjoint") check | Flags/escalates on genuine uncertainty instead of guessing ([source](https://www.functionize.com/blog/self-healing-tests-arent-magic-heres-whats-actually-happening-under-the-hood)) |

**Failure modes, stated by the vendors/projects themselves, not critics:**

* **Selector healing is a narrow slice of real flakiness.** QA Wolf's own
  taxonomy attributes only ~28% of healed failures to selector drift; the
  rest are timing (~30%), test data (~14%), visual-assertion noise (~10%),
  interaction-order changes (~10%), and runtime errors unrelated to the
  feature (~8%). Their conclusion: "most test flakes have nothing to do with
  selectors at all," so selector-only healing "leav[es] over 70% of real
  failures unrepaired"
  ([The 6 Types of AI Self-Healing](https://www.qawolf.com/blog/self-healing-test-automation-types)).
* **"Silent heal" is the dangerous case.** A misdiagnosed failure — e.g., an
  API delay or an unexpected redirect to a login page — can be "healed" by
  pointing the selector at a plausible but wrong element. The test then passes
  green, merges, and the real defect ships; QA Wolf and Functionize both use
  nearly identical language for this: "silent wrong recoveries lead to false
  passes that hide real defects" and self-healing systems "are more dangerous
  than one that fails explicitly" when they recover confidently while actually
  uncertain
  ([QA Wolf](https://www.qawolf.com/blog/self-healing-test-automation-types),
  [Functionize](https://www.functionize.com/blog/self-healing-tests-arent-magic-heres-whats-actually-happening-under-the-hood)).
* **Self-healing cannot validate business correctness.** Functionize states
  this plainly: "Self-healing is constrained by your verifications. It cannot
  override a failed verification" — it repairs *how* an element is found, not
  *whether* the assertion should have passed
  ([source](https://www.functionize.com/blog/self-healing-tests-arent-magic-heres-whats-actually-happening-under-the-hood)).
* **Known, vendor-acknowledged gaps persist even in mature products.**
  Katalon's own docs admit its AI tier "might have issues finding the element
  with the image locator" and call it a module still being improved
  ([source](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio)).
  Healenium's Playwright integration is acknowledged as materially behind its
  original Selenium support.
* **Human-reviewed healing is a deliberate design choice by at least one
  vendor.** Tricentis Testim treats UI-change detection and update-proposal as
  a review step ("recommends updates ... which can be reviewed and applied
  with a single click") rather than auto-applying every heal — a middle
  ground between "always ask a human" and "always heal silently"
  ([source](https://www.tricentis.com/news/tricentis-acquires-ai-based-saas-test-automation-platform-testim)).

## Recommendations for `dynamic-qa`

### Borrow (concepts, not code)

* **The Planner → Generator → Healer role split.** Playwright's own agent
  architecture validates the shape `dynamic-qa` already intends: a
  human-authored (not AI-explored) flow plays the Planner's role, an AI
  Generator compiles it into runnable tests, and a bounded Healer repairs
  mechanical breakage under guardrails rather than unlimited retries
  ([Test Agents](https://playwright.dev/docs/test-agents)).
* **Diagnose-before-heal, not heal-on-any-failure.** QA Wolf's own taxonomy
  shows selector patching alone is the wrong default response to most
  failures; `dynamic-qa`'s healer (or its equivalent) should classify a
  failure (selector / timing / data / visual / runtime) before choosing a
  repair strategy, mirroring the taxonomy in
  [QA Wolf's write-up](https://www.qawolf.com/blog/self-healing-test-automation-types).
* **Never auto-heal silently past a business assertion.** Adopt Functionize's
  rule verbatim as a design constraint: healing may fix *how* a step finds
  something, never *whether* an assertion result should count as pass. Any
  heal that touches an assertion (versus a locator/wait) should require human
  sign-off, echoing Tricentis's "propose, human applies" model rather than
  mabl/Reflect's default of healing and continuing.
* **An open, versionable intermediate representation.** Playwright Planner's
  choice to write a human-readable Markdown spec to a repo path (`specs/`)
  before generation — rather than keeping the plan inside a vendor's hosted
  state — is exactly the pattern `dynamic-qa` needs for its 5–10 QA-defined
  flows: durable, diffable, reviewable by a human, and the actual input
  contract to the generator.

### Wrap / depend on (call as an external tool, don't reimplement)

* **Playwright itself, and ideally `@playwright/mcp`, as the browser execution
  backend for any generated web tests.** Its accessibility-tree-first
  approach is already the token-efficient, deterministic representation an
  LLM-driven generator/healer needs; reimplementing browser control or
  element description would only reproduce work Microsoft already maintains
  ([microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)).
* **Spec-driven contract-test generation for the API layer.** Where a flow
  touches an API with an OpenAPI/Swagger spec, generate contract-tier checks
  the way Portman does (status/schema/content-type/timing) mechanically from
  the spec rather than asking an LLM to invent them — this is a solved,
  narrow problem
  ([apideck-libraries/portman](https://github.com/apideck-libraries/portman)).
  Reserve the LLM for the parts a spec can't express: business-level
  assertions and multi-step journeys, which is what Postman's own Agent Mode
  targets by reading actual traffic rather than only the spec
  ([Postman Agent Mode](https://blog.postman.com/testing-apis-with-postman-agent-mode-a-practical-guide/)).
* **Locator-healing libraries as a pluggable fallback, not the product.** If
  `dynamic-qa` needs runtime self-healing for generated Playwright tests, an
  existing library (Healenium-style similarity matching, or Playwright's own
  Healer agent) is a dependency, not a component to build from scratch —
  particularly since the hard part (avoiding silent false-heals) is a policy
  decision `dynamic-qa` must own regardless of which matching library sits
  underneath.

### Avoid rebuilding

* **A closed, hosted "plain English → proprietary runtime" execution engine**
  in the style of testRigor or Virtuoso QA. Building an NLP-to-action
  interpreter that only runs inside a bundle-owned service would recreate
  years of vendor investment and would contradict `dynamic-qa`'s explicit goal
  of running in the *customer's own* CI — the one property none of the
  closed-platform vendors offer.
* **Browser driving, DOM/accessibility-tree extraction, or vision-based
  element location.** This is exactly what Playwright (and Playwright MCP)
  already solves well; any dynamic-qa-specific reimplementation would be
  strictly worse and a maintenance burden.
* **A general-purpose ML similarity/self-healing matcher from scratch.**
  Functionize's "5D fingerprint plus time-series drift" and Healenium's
  DOM-similarity model both represent substantial, ongoing R&D; the
  differentiator `dynamic-qa` actually needs is the *policy* layer (diagnose
  failure type, gate business-assertion changes behind a human, never heal
  silently past a real defect) rather than a better locator-matching
  algorithm.
* **Ad hoc OpenAPI-to-test conversion logic.** This is a solved, mechanical
  problem (Portman and Postman's own OpenAPI import already do it); writing a
  bespoke version would spend effort on the least differentiated part of the
  system.
