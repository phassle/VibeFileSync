# Research: Flow-definition formats for `dynamic-qa`

## Question

`dynamic-qa` is a two-skill bundle: a QA-expert-facing setup interview captures
5–10 important business flows as a **tech-neutral flow definition**, and a
second skill (`qa-generate`) has an AI consume that definition to
generate/repair regression tests, picking the test level (browser, API, or
CLI) per flow. What existing flow-description formats and testing paradigms
already try to separate an abstract flow from its concrete execution layer,
how do they bind the two together, where do they put assertions/test
data/mocking, and which properties should a new tech-neutral format borrow or
avoid so that (a) a QA expert can author it unassisted in a guided interview
and (b) an AI can consume it deterministically to generate tests at a chosen
level?

## Primary-source findings

### Gherkin/BDD: the step text is the tech-neutral layer, the step definition is where technology enters

Gherkin's own reference frames Given/When/Then as an implementation-agnostic
narrative convention: `Given` sets up a known state, `When` describes an
action or event, and `Then` asserts an observable outcome, and the guidance
explicitly warns authors to write steps as if "it's 1922, when there were no
computers," pushing all technology detail out of the step text and into the
[step definitions](https://cucumber.io/docs/cucumber/step-definitions) that
back them ([Gherkin reference](https://cucumber.io/docs/gherkin/reference/)).
`Background` factors out repeated `Given` steps shared by every scenario in a
file ([Gherkin reference — Background](https://cucumber.io/docs/gherkin/reference/#background)).

The binding mechanism is the **step definition**: "a method with an
expression that links it to one or more Gherkin steps." Cucumber matches the
literal step text against a step definition's Cucumber Expression (e.g.
`{int}`) or a regular expression, and only the step-definition code — not the
Gherkin text — actually calls the system under test
([step definitions](https://cucumber.io/docs/cucumber/step-definitions/)).
Because that matching is by string pattern rather than by any structural
schema, **the same abstract step wording can be bound to different
step-definition implementations in different projects or suites** — one
project's step-definition file can drive a browser, another's can drive an
HTTP client, and Cucumber's Gherkin layer has no opinion on which. Nothing in
the Gherkin/step-definition contract forces a single technology; it just
requires that some registered step definition matches the step text at run
time. Assertions are not a Gherkin construct — the reference shows step
definitions containing arbitrary code, and Cucumber's own docs do not give
Gherkin an assertion syntax, which is why the practical convention is
"assertions live in step-definition/glue code," not in the feature file.

Test data has two first-class, tech-neutral mechanisms in Gherkin itself:
- **Scenario Outline + Examples**: the scenario is a template with
  `<placeholder>` tokens, and Cucumber "runs [it] once for each row in the
  `Examples` section," substituting values before step matching
  ([Gherkin reference — Scenario Outline](https://cucumber.io/docs/gherkin/reference/#scenario-outline)).
- **Data Tables**: a pipe-delimited table is passed as the last argument to
  the matching step definition, used for structured multi-row input like "the
  following users exist" ([Gherkin reference — Data Tables](https://cucumber.io/docs/gherkin/reference/#data-tables)).

Gherkin has **no first-class mocking/boundary construct**. There is nothing in
the reference for declaring "this dependency is a stub" — any such boundary
has to be expressed as ordinary `Given` setup prose and then implemented
inside step-definition code, entirely outside the spec layer's visibility.

### Playwright: assertions and test data live entirely in code; the "agentic" surface talks to the browser, not to a spec format

Playwright Test's model is code-first, not a declarative spec language: a test
is a `test()` function that performs actions through the **Locators API**
(`getByRole()`, `click()`, `fill()`, etc.) and asserts state with the
**`expect()`** async matchers (`toBeVisible()`, `toContainText()`,
`toHaveURL()`, …), which "wait until the expected condition is met" so tests
are non-flaky ([Writing tests](https://playwright.dev/docs/writing-tests)).
Test data and page-interaction logic are conventionally centralized behind
the **Page Object Model** pattern: POMs "simplify authoring" and "simplify
maintenance by capturing element selectors in one place," and tests then
instantiate a page object, call its methods, and assert through
`expect(pageObject.locator)...` ([Page object models](https://playwright.dev/docs/pom)).
There is no separate "flow definition" artifact — the code *is* the flow, the
assertion, and the binding, all at once, hard-wired to the browser layer.

**Codegen** is Playwright's flow-capture tool, not a spec format: running
`npx playwright codegen [URL]` opens a real browser plus the Playwright
Inspector, records clicks/fills/navigation as the user performs them, and
emits runnable test code, picking locators that "prioritiz[e] role, text, and
test id" ([Generating tests](https://playwright.dev/docs/codegen-intro)). It
also supports a small fixed set of recordable assertions (visibility, text
content, value) and a standalone locator picker/playground
([Test generator](https://playwright.dev/docs/codegen)). Codegen's output is
inherently single-layer: it only knows how to emit browser-automation code,
because it is driving and recording an actual browser session.

**Trace Viewer** is a post-hoc debugging tool for a run that already
happened, not a spec/binding mechanism: it replays action-by-action DOM
snapshots, a screenshot filmstrip, network requests, and console logs for a
recorded trace, and maps each action back to its source line
([Trace viewer](https://playwright.dev/docs/trace-viewer)).

Playwright's explicitly agentic artifact is **`@playwright/mcp`**, a Model
Context Protocol server, not a test-generation format: its own README states
it is "a Model Context Protocol (MCP) server that provides browser automation
capabilities using Playwright... enables LLMs to interact with web pages
through structured accessibility snapshots, bypassing the need for
screenshots or visually-tuned models" for token efficiency and "deterministic
tool application" ([microsoft/playwright-mcp README](https://github.com/microsoft/playwright-mcp)).
This is a live-control protocol for an agent driving a browser turn-by-turn —
useful as an execution adapter an AI could call *when generating or repairing
a browser-level test*, but it says nothing about representing an abstract,
technology-neutral flow; it is, if anything, further evidence that
"agentic + browser" tooling in this ecosystem still assumes the browser is
the layer, not one of several interchangeable layers.

### Model-based testing: the closest existing analogue to "one abstract flow, many concrete adapters"

The ISTQB glossary anchors the vocabulary: a **Test Model** is "a model
describing testware that is used for testing a component or a system under
test," and **model-based testing** "uses models of the system under test
(SUT) to support automation in... test case generation and test execution,"
with a **state-machine test model** being "a computational model consisting
of a finite number of states and transitions between those states, possibly
with accompanying actions"
([ISTQB Glossary — Test Model](https://istqb-glossary.page/test-model/)).

GraphWalker is a canonical MBT tool built directly on that vocabulary: a
model is "a graph, which is a set of vertices and edges," where "a vertex
represents verification, an assertion" and "an edge represents an action, a
transition" — e.g. an API call, a button click, a timeout
([GraphWalker](https://graphwalker.github.io/)). GraphWalker "walks" the
graph by generating a path (a sequence of vertices/edges) from a start point,
a path-generator strategy, and a stop condition — this path *is* the abstract
flow, entirely independent of what technology will execute it.

The binding mechanism that matters most for `dynamic-qa` is the **test
adapter / model-implementation class** pattern used by AltWalker (a
GraphWalker-based executor): "each vertex and edge from the model is mapped
to a method inside the class," and "every model is mapped to a class with
the same name"
([AltWalker overview](https://altom.gitlab.io/altwalker/altwalker/overview.html)).
Critically, AltWalker supports multiple executor languages/runtimes (Python,
.NET/C#, and a custom HTTP executor) — "allowing the same graph model to be
executed against different concrete implementations" — and separate
online/offline planning modes without touching the model itself. This is the
one paradigm in this research set that explicitly ships a **1-model-to-N-adapters**
architecture: the abstract flow (graph) is a standalone artifact; each
concrete adapter class independently decides what "visit this vertex" or
"traverse this edge" means in its own technology. Assertions live in the
adapter's vertex methods, not in the graph description; test data is whatever
parameters the adapter code chooses to use when it implements an edge/vertex
method — the model format itself carries no data-table concept. Mocking is
likewise entirely an adapter-level decision; the graph has no notion of a
mocked boundary.

### Custom YAML/DSL approaches: Karate and Gauge sit at opposite ends of "tech-neutral"

**Karate** looks like Gherkin but its own docs show the flow-definition layer
is **not** tech-neutral — HTTP is baked directly into the "spec" language.
Karate's syntax reference organizes "Keywords for building and executing HTTP
requests" — `url`, `path`, `method`, `status`, `request`, `param`, `header`,
`cookie` — as first-class Gherkin-step keywords, so a feature file reads like
`Given url '...' / And path 'users' / When method post / Then status 201`
([Syntax Reference](https://docs.karatelabs.io/api-reference/syntax-reference/)).
Assertions are inline in the same file via the `match` keyword — "Karate's
primary assertion mechanism," doing structural/fuzzy comparison such as
`match response == { id: 1, name: 'John' }` — so, unlike Gherkin/Cucumber,
Karate deliberately keeps assertions **in** the spec text rather than pushing
them into glue code. Test data uses Scenario Outline + Examples exactly as in
Gherkin, plus embedded expressions. Mocking is first-class and lives in the
*same* file format: Karate's mock server feature defines a mock as ordinary
`Scenario`s matched by predicates like `pathMatches('/users/{id}')` and
`methodIs('post')`, evaluated top-to-bottom until one matches, and can be
started standalone (`karate mock -m users.feature -p 8080`) or from inside a
test (`karate.start('classpath:mocks/user-mock.feature')`)
([Test Doubles and Mocking](https://docs.karatelabs.io/extensions/test-doubles/)).
Karate is therefore a strong model for "assertions and mocks as first-class,
readable syntax," but a cautionary example for tech-neutrality: its spec
layer is hard-wired to HTTP (and, via a separate `driver` subsystem, to a
browser), so the same Karate feature file cannot describe a flow that is
later realized at the CLI level without leaving the format's own keyword set.

**Robot Framework** is keyword-driven rather than HTTP- or browser-specific
at its syntax level: a test case is a tabular sequence of keyword calls, and
"a test case fails if any of the keyword it uses fails" — the *tabular test
data itself* has no assertion syntax; assertions arrive only through
whichever keyword a library provides, such as `Should Be Equal` from the
BuiltIn library
([Robot Framework User Guide](https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html)).
This makes Robot Framework's test-case layer genuinely tech-neutral **by
construction** — the same tabular test could call `Click Element` from a
Selenium/Browser library or `GET` from an HTTP-client library, because the
keyword name is just a lookup key into whatever library is imported for that
suite. Test data is supplied via a `Variables` section, external
resource/variable files, or "Test Templates" for data-driven repetition. The
User Guide's own material has **no first-class mocking construct**: mocking
is left entirely to whatever library is imported (there is no Robot-level
"this call is a stub" keyword), matching Gherkin's gap in the same area.

**Gauge** keeps specs in literal Markdown: a spec has an H1 heading, `##`
scenarios, and `*`-prefixed steps, and Gauge's own framing is that "a
specification is a business test case which describes a particular feature of
the application that needs testing," with steps binding to implementation
code through language-specific annotations (`@Step("...")` in Java,
`[Step(...)]` in C#, `step()` in JS/Python/Ruby) whose parameter count must
match the step text's placeholders
([Writing Specifications](https://docs.gauge.org/writing-specifications.html)).
Gauge factors out reusable step groups into **Concepts** (separate `.cpt`
files with their own parameterized header), and supports data-driven
execution via inline tables or an external `<table:filename.csv>` reference,
executing the scenario once per row. Like Gherkin and Robot Framework, Gauge
keeps assertions out of the spec text — the Markdown layer has no assertion
syntax at all, only step text — and, like both, it has **no first-class
mocking concept**; the only hook toward test-boundary setup is generic
`@BeforeScenario`/`@AfterScenario` lifecycle annotations in the implementation
language, not the spec.

### Spec-by-example: genuinely first-party, but sparse as a "format" per se

A first-party primary source does exist: Gojko Adzic's own retrospective post
states the book "documented a flow of seven common steps from a business goal
to an automated test that can act as self-checking documentation," and that
"specifying collaboratively" — producing examples through conversation before
they are automated — is "the key to the process," citing Liz Keogh's framing
that "having conversations is more important than capturing conversations is
more important than automating conversations"
([Specification by Example, 10 years later — gojko.net](https://gojko.net/2020/03/17/sbe-10-years.html)).
The same post gives the living-documentation payoff directly: "when a single
document represents both a specification and a test, then it's impossible to
forget updating one without the other." Adzic's own book page confirms the
intended audience — "testers, business analysts, developers and project
managers" — and the goal of using concrete examples as both specification and
executable test ([Specification by Example — gojko.net](https://gojko.net/books/specification-by-example/)).
Cucumber's own BDD overview independently converges on the same idea without
naming Adzic: it frames the goal as producing "system documentation that is
automatically checked against the system's behaviour," in "a medium that can
be read by both humans and computers"
([What is BDD? — cucumber.io](https://cucumber.io/docs/bdd/)). Gauge's own
description — specs as a literal "business test case" written in the
"business language" — is the same living-documentation framing applied to a
Markdown-based tool, though Gauge's own docs do not use the phrase
"specification by example." Spec-by-example, per its own originating source,
is a *collaborative-process* claim (conversation → example → automation)
rather than a syntax or file-format claim — it says nothing about how to keep
a spec tech-neutral across browser/API/CLI, which is exactly the gap Gherkin,
Karate, Robot Framework, and Gauge each fill differently at the syntax level.

## Comparison summary

| Approach | Binding mechanism | Can point at different tech layers? | Assertions | Test data | Mock/boundary |
| --- | --- | --- | --- | --- | --- |
| **Gherkin/Cucumber** | Step text ↔ step-definition pattern match (Cucumber Expression/regex) | Yes — same wording, different step-definition code per project/layer | In step-definition/glue code only | Scenario Outline + Examples; Data Tables | None first-class; left to glue code |
| **Playwright Test** | None — code is the flow, no separate spec artifact | No — hard-wired to `page`/browser | In-code, via `expect()` | In code/fixtures, no declarative table | None first-class; left to code (route mocking is a code-level API) |
| **MBT (GraphWalker/AltWalker)** | Graph model ↔ adapter class where each vertex/edge maps to a method | Yes, explicitly — same model, swappable executor language/runtime | In adapter vertex methods | Adapter code decides; no format-level table | None first-class; adapter decides |
| **Karate** | Same `.feature` file is both spec and glue (keywords execute directly) | No — HTTP (and a separate browser `driver` mode) is baked into the keyword set | In spec text, via `match` | Scenario Outline + Examples; embedded expressions | First-class — mocks are `Scenario`s in the same file format |
| **Robot Framework** | Keyword name ↔ whatever library implements it | Yes — same tabular keyword call, any backing library (HTTP, browser, CLI) | In library keywords, not in test-data syntax | Variables section, resource/variable files, Templates | None first-class; left to libraries |
| **Gauge** | Step text ↔ language-specific step-annotation function | Yes — same Markdown step text, any language implementation | In implementation code, not Markdown | Inline tables or external CSV, `<table:file.csv>` | None first-class; only generic before/after hooks |

## Recommendation

**Draw most heavily from Gherkin/Cucumber's step-text/step-definition split and
Robot Framework's keyword-indirection principle; avoid Karate's and
Playwright's approach of hard-wiring the spec layer to one technology.** The
evidence above converges on a small set of properties `dynamic-qa`'s flow
format should have:

1. **Keep the abstract flow as pure intent, never as a technology keyword.**
   Gherkin's own guidance — write steps as if it's 1922 — and Robot
   Framework's clean separation of "keyword name" from "what the keyword
   does" are the two best evidence points that a flow step should read like
   "the customer submits the order," never "POST /orders" or "click
   `#submit`." Karate is the cautionary counter-example: because `url`,
   `method`, and `status` are keywords in the spec language itself, a Karate
   feature file cannot be picked up and re-targeted at a CLI test without
   rewriting the spec, which defeats the entire point of a tech-neutral
   format for this project.

2. **The binding artifact should be an indirection the AI owns, not something
   the QA expert writes.** Cucumber's step definition and Robot Framework's
   keyword-library lookup are both proof that "same text, swappable
   implementation" is a solved, well-precedented pattern — and in both cases
   the *human-authored* layer never names the implementation. For
   `dynamic-qa`, `qa-generate` (the AI) should be the thing that owns the
   equivalent of the step-definition/keyword-library layer: given a flow
   step and a chosen test level, it decides what "submits the order" means as
   Playwright code, an HTTP call, or a CLI invocation. AltWalker's adapter
   pattern is the cleanest formalization of exactly this: one model, N
   adapter classes, chosen independently of the model — this is the
   structural template to imitate (flow definition = model; qa-generate's
   generated test code per level = adapter), not GraphWalker/AltWalker's
   actual graph syntax, which is unnecessarily heavyweight (explicit
   vertices/edges/path-generators) for 5–10 QA-authored flows that are almost
   always linear-with-branches, not open-ended state spaces.

3. **Assertions belong at the flow-definition layer as tech-neutral outcome
   statements, not as literal code — but that is a spectrum question, and
   Karate is useful evidence for the "some inline expectation language is fine
   and readable" side.** Pure Cucumber/Gauge/Robot Framework push assertions
   entirely out of the spec, which is bad for this project because the QA
   expert authoring the interview *is* the one who knows the expected
   outcome and won't be present when `qa-generate` runs later — if the
   expectation isn't captured in the flow definition, it's lost. Karate shows
   a workable middle ground: keep a lightweight, technology-agnostic
   expectation ("total reflects the discount," "confirmation email is sent")
   in the flow text, and let the AI translate that into a concrete assertion
   (`expect(page.locator(...)).toHaveText(...)`, a JSON-body `match`, or a CLI
   exit-code/stdout check) per test level — i.e., inline expectation
   *language*, not inline expectation *code*.

4. **Test data should be referenced via a named table/example set, not
   invented ad hoc per flow.** Every format in this research
   (Gherkin's Scenario Outline + Examples, Karate's Examples, Robot
   Framework's Variables/Templates, Gauge's inline or external CSV tables)
   independently converges on "a named table of rows substituted into
   placeholders." That convergence is strong evidence this is the right
   primitive: the flow definition should name/reference data (e.g. "for each
   of: valid customer, guest checkout, expired card") and let the actual
   values live in a table attached to the flow, exactly as Scenario Outline +
   Examples or Gauge's `<table:file.csv>` do — never embed literal
   environment-specific values (URLs, selectors, endpoints) in the flow text
   itself.

5. **Mock/boundary declarations need to be first-class in the format, which
   is the one place none of Gherkin, Robot Framework, or Gauge is a good
   model — only Karate is.** Karate's mock-as-`Scenario`-in-the-same-file
   approach is the one piece of primary-source evidence in this set that a
   declarative format *can* make "this dependency is faked" a readable,
   authorable statement rather than leaving it entirely to whichever
   automation engineer writes the glue code. For `dynamic-qa`, a QA expert in
   a guided interview should be able to say "the payment gateway is mocked to
   always approve" as part of the flow, tech-neutrally (not as a Karate
   `Scenario`/`pathMatches` predicate, which is HTTP-specific) — the AI then
   decides how to realize that boundary at whichever test level it picks
   (an HTTP mock server, a CLI environment stub, or a Playwright route
   interceptor).

6. **The flow definition should not name a test level; that decision belongs
   to `qa-generate`, and every surveyed format supports this by construction.**
   None of Gherkin, Robot Framework, Gauge, or the MBT adapter pattern bakes
   a test level into the abstract definition — the level is a property of
   the *binding* (step definition, keyword library, or adapter), decided at
   generation/execution time. Only Karate and Playwright collapse the two,
   and both pay for it with a spec layer that cannot be retargeted. The flow
   definition's schema should therefore carry enough information for
   `qa-generate` to *infer* a sensible level (e.g., "user visits page X" implies
   browser; "system processes a webhook" implies API; "operator runs a batch
   job" implies CLI) without ever requiring the QA author to state the level
   explicitly, while still allowing an explicit override field for the rare
   case the author already knows.

7. **Human-readability vs. machine-parseability: pick a structured
   human-readable text format (Gherkin- or Gauge-like), not free markdown
   prose and not a code-shaped DSL (Karate/Robot Framework tables).** Gauge's
   own framing — specs as literal "business test case[s]" in "business
   language," authored and read by non-programmers — combined with
   Cucumber's convergent "medium that can be read by both humans and
   computers" framing of BDD, is the strongest primary-source evidence for a
   line-oriented, keyword-anchored text format (`Given/When/Then`-style, or
   Gauge's `*`-bulleted steps) over both unconstrained prose (not reliably
   machine-parseable) and a tabular/code-like DSL (readable to an automation
   engineer, not to "a QA expert unassisted in a guided interview," and prone
   to leaking technology as Karate demonstrates). Concretely: reuse Gherkin's
   Given/When/Then/Examples grammar as the outer shape (it is already the
   most widely understood tech-neutral convention for this per the sources
   above), but add two extensions neither Gherkin nor Gauge has: an inline,
   tech-neutral expectation clause per step (per point 3) and an explicit,
   named mock/boundary declaration block (per point 5) — and leave test-level
   selection out of the grammar entirely (per point 6).
