# Research: `anti-flakiness-practices`

## Question

For [issue #98](https://github.com/phassle/VibeFileSync/issues/98) — feeding the
`qa-generate` spec inside the `dynamic-qa` skill bundle map
([issue #95](https://github.com/phassle/VibeFileSync/issues/95)) — what do
primary sources (framework docs, first-party engineering blogs, and academic
flaky-test taxonomies) say about keeping generated regression tests
non-flaky? The goal is a set of rules `qa-generate` can encode directly when
it builds browser, API, and CLI tests: where to draw the mocking boundary,
which selectors resist markup churn, how to wait/retry without fixed sleeps,
and how to isolate test data across runs.

## Rules for qa-generate

1. **Mock only what the test isn't verifying.** Mock/stub third-party
   services, payment gateways, and any dependency your application doesn't
   own or control. Do **not** mock the primary API/DB/service the test's
   assertions are actually exercising — hit it for real, or the test stops
   verifying the thing it claims to verify. (Playwright
   ["Avoid testing third-party dependencies"](https://playwright.dev/docs/best-practices#avoid-testing-third-party-dependencies);
   Cypress ["Visiting external sites"](https://docs.cypress.io/app/core-concepts/best-practices#Visiting-External-Sites);
   Cypress ["Use Server Responses"](https://docs.cypress.io/app/guides/network-requests#Use-Server-Responses) —
   real requests only for critical paths, sparingly; Google Testing Blog
   ["Test Sizes"](https://testing.googleblog.com/2010/12/test-sizes.html) —
   network/DB/filesystem access is banned for small tests, allowed for
   medium/large.)
2. **Freeze or inject system time; never depend on wall-clock time.** Use a
   clock-control API (e.g. Playwright's `page.clock`) or inject a fixed
   `Date`/timestamp at the API/CLI layer rather than letting `Date.now()` run
   free. (Playwright [Clock](https://playwright.dev/docs/clock); Luo et al.,
   [FSE'14](https://mir.cs.illinois.edu/lamyaa/publications/fse14.pdf) — "Time"
   is a named flaky-test root-cause category, e.g. midnight/timezone
   boundaries and low timer granularity causing intermittent timestamp
   collisions.)
3. **Mock/seed randomness deterministically.** Any code path a regression
   test exercises that calls a random-number source must be seeded or
   stubbed so results are reproducible. (Luo et al. FSE'14 names
   "Randomness" as a distinct flaky-test category; Lam et al.
   [ISSTA'19](https://mir.cs.illinois.edu/winglam/publications/2019/LamETAL19RootFinder.pdf)
   documents a real Microsoft test flaky because two unseeded `Random`
   instances created close together returned identical sequences.)
4. **Never mock a payment gateway's success path away from the assertion
   under test, but never call a real one either.** Route it through the
   framework's HTTP interception layer (Playwright `page.route`/`context.route`,
   Cypress `cy.intercept`) so the response is deterministic and no real money
   or external state moves. (Playwright [Mock APIs](https://playwright.dev/docs/mock);
   Cypress [Network Requests — Stub Responses](https://docs.cypress.io/app/guides/network-requests#Stub-Responses).)
5. **Prefer `getByRole`/ARIA-role locators first, for browser tests.** Fall
   back in order: text/label queries, then a stable `data-testid`
   attribute, and treat CSS-class or XPath selectors tied to DOM structure
   as a last resort only. (Playwright
   [Locators — "When to use role locators"](https://playwright.dev/docs/locators#locate-by-role);
   Testing Library [query priority](https://testing-library.com/docs/queries/about/#priority) —
   `getByRole` "should be your top preference for just about everything,"
   `getByTestId` is last resort because "the user cannot see (or hear)
   these.")
6. **Never use fixed `sleep()`/`wait(N ms)`.** Use the framework's
   auto-waiting/auto-retrying assertions with a bounded timeout instead of a
   hard-coded delay, at every test level. (Playwright
   [Best Practices — "Use web first assertions"](https://playwright.dev/docs/best-practices#use-web-first-assertions);
   Cypress [Retry-ability](https://docs.cypress.io/app/core-concepts/retry-ability);
   Luo et al. FSE'14, Table 4 — `sleep`-based fixes only *decrease* flakiness
   probability while `waitFor`-based fixes *remove* it in 55% of cases,
   because `sleep` "cannot provide the guarantee" that the awaited event
   actually happened within the delay.)
7. **Never rely on `networkidle`/global idle detection as a readiness
   signal.** Wait for the specific state the test depends on — a visible
   element, a resolved response, a specific navigation — not on the network
   going quiet. (Playwright API docs: `networkidle` is marked
   **DISCOURAGED** — "Don't use this method for testing, rely on web
   assertions to assess readiness instead.")
8. **For API-level checks against eventually-consistent systems, poll the
   assertion with a bounded timeout rather than asserting once.** Use
   `expect.poll`/`expect.toPass` (Playwright) or an equivalent retrying
   assertion instead of a single immediate check. (Playwright
   [Test assertions — `expect.poll`, `expect.toPass`](https://playwright.dev/docs/test-assertions#expectpoll).)
9. **For CLI-level checks, wait on the process's actual exit code / stdout
   marker, never on a fixed timer.** Treat the async-completion signal
   (process exit, a specific log line, a lock-file/socket appearing) as the
   thing to poll for, applying the same "wait for a condition, not a
   duration" principle the browser/API guidance establishes. (Extrapolated —
   see caveat under CLI findings below; no CLI-specific primary source was
   found. General principle from Playwright auto-waiting +
   Luo et al. FSE'14 Async-Wait category, which is language/platform
   agnostic.)
10. **Give every test run a unique data namespace/ID.** Generate unique
    identifiers (UUIDs, timestamps, per-run prefixes) for any record a test
    creates, so parallel or repeated runs cannot collide. (Cypress
    [Best Practices — "Having Tests Rely On The State Of Previous Tests"](https://docs.cypress.io/app/core-concepts/best-practices#Having-Tests-Rely-On-The-State-Of-Previous-Tests);
    Lam et al. ISSTA'19 / Luo et al. FSE'14 name "Test Order Dependency" as a
    top-3 flaky-test root cause, caused by tests sharing state that isn't
    reset.)
11. **Reset/tear down state before each test, not just after.** Prefer
    `beforeEach`-style setup over relying on `afterEach` cleanup, since a
    crashed or skipped previous test can skip teardown but not the next
    test's setup. (Cypress Best Practices — "State reset should go before
    each test"; Playwright [Test fixtures](https://playwright.dev/docs/test-fixtures) —
    test-scoped fixtures are torn down after each test and re-created fresh
    per test.)
12. **Never depend on execution order.** Every test must pass when run with
    `.only()`/in isolation and in any order; do not let test B assume test A
    ran first and left data behind. (Cypress
    [Test Isolation](https://docs.cypress.io/app/core-concepts/test-isolation) —
    "Having tests that depend on the state of an earlier test can
    potentially cause nondeterministic test failures"; Luo et al. FSE'14 —
    "Test Order Dependency" is 12% of studied flaky-test-fixing commits and
    74% of its fixes work by "cleaning the shared state between test runs";
    Google Testing Blog, ["Test Sizes"](https://testing.googleblog.com/2010/12/test-sizes.html) —
    Google requires that tests "can be run in any order," which "in turn
    means that tests need high isolation — you can't rely on some other test
    leaving data behind.")
13. **Prefer real API calls for one true end-to-end critical path, stub the
    rest.** Don't make every generated test a full real-network end-to-end
    test; that trades flakiness for slowness and coupling to unrelated
    systems. (Cypress [Network Requests — Stub Responses](https://docs.cypress.io/app/guides/network-requests#Stub-Responses) —
    "typically have one true end-to-end test, and then stub the rest.")

## Findings by area

### Mocking boundary

- **Playwright**: [Best Practices § "Avoid testing third-party
  dependencies"](https://playwright.dev/docs/best-practices#avoid-testing-third-party-dependencies)
  states tests should not depend on sites/services you don't control;
  instead "use the Playwright Network API and guarantee the response
  needed" via `page.route(...).fulfill(...)`. The framing is explicit: mock
  what you cannot control, and test your application's handling of expected
  responses — not the third party's actual behavior.
- Playwright's [Mock APIs](https://playwright.dev/docs/mock) guide draws the
  boundary the other direction too: "Sometimes, it is essential to make an
  API request, but the response needs to be patched to allow for
  reproducible testing" — i.e. for the API the test *is* exercising, prefer
  making the real call and only patching the response for determinism
  (three approaches: direct mock/fulfill, capture-and-patch, or replay a
  committed HAR file), rather than a blanket local double.
- Playwright's [Clock](https://playwright.dev/docs/clock) API exists
  specifically so time-dependent behavior (timeouts, scheduled tasks,
  rendering that depends on `Date.now()`) can be tested deterministically:
  "Accurately simulating time-dependent behavior is essential for verifying
  the correctness of applications," with `setFixedTime` as "the recommended
  approach."
- **Cypress**: [Best Practices § "Visiting External Sites"](https://docs.cypress.io/app/core-concepts/best-practices#Visiting-External-Sites)
  says "Only test websites that you control. Try to avoid visiting or
  requiring a 3rd party server." For things like social login it recommends
  driving the provider's own programmatic API (`cy.request()`) rather than
  automating their UI, because third-party UIs carry "A/B testing,
  throttling, captchas" outside your control.
- Cypress's [Network Requests guide](https://docs.cypress.io/app/guides/network-requests)
  draws the exact "verify vs. don't verify" line the rules above encode:
  real, unstubbed requests "guarantee that the client and server contract is
  working correctly" and should be "used sparingly" for "the critical paths
  of your application" (login, signup, billing). Stubbed responses should be
  used "for the vast majority of tests" because they're fast (<20ms) and
  fully controllable; the suggested mix is "one true end-to-end test, and
  then stub the rest."
- **Google Testing Blog, ["Test Sizes"](https://testing.googleblog.com/2010/12/test-sizes.html)**
  (Simon Stewart, 2010) gives a concrete, checkable table of what's allowed
  per test size:

  | Feature | Small | Medium | Large |
  |---|---|---|---|
  | Network access | No | localhost only | Yes |
  | Database | No | Yes | Yes |
  | File system access | No | Yes | Yes |
  | Use external systems | No | Discouraged | Yes |
  | Sleep statements | No | Yes | Yes |
  | Time limit (seconds) | 60 | 300 | 900+ |

  This is a first-party, data-driven statement that the smaller/faster a
  regression test is meant to be, the more external dependencies it must
  have mocked away — and that "using external systems" should be
  "discouraged" even for medium (integration) tests, reserved for large
  (end-to-end) ones.
- **Academic corroboration**: Luo et al.,
  ["An Empirical Analysis of Flaky Tests"](https://mir.cs.illinois.edu/lamyaa/publications/fse14.pdf)
  (FSE 2014) name "Network," "Time," "IO," and "Randomness" as four of their
  ten flaky-test root-cause categories, each caused by a test depending on
  something outside its control that the fix should have isolated (e.g. "the
  test failure does not necessarily mean the CUT itself is buggy, but rather
  the developer does not account for network uncertainties").

### Selector resilience (browser)

- **Playwright, [Locators](https://playwright.dev/docs/locators)** gives an
  explicit priority order: `getByRole()` first, then `getByText()`,
  `getByLabel()`, `getByPlaceholder()`/`getByAltText()`/`getByTitle()`, then
  `getByTestId()` as fallback, with CSS/XPath last. Under "Locate by role":
  "Role locators include buttons, checkboxes, headings, links, lists,
  tables, and many more and follow W3C specifications for ARIA role, ARIA
  attributes and accessible name," and "We recommend prioritizing role
  locators to locate elements, as it is the closest way to how users and
  assistive technology perceive the page." Test IDs are flagged as resilient
  but not user-facing: "Testing by test ids is the most resilient way of
  testing... however testing by test ids is not user facing." CSS/XPath is
  explicitly discouraged: "XPath and CSS selectors can be tied to the DOM
  structure or implementation. These selectors can break when the DOM
  structure changes."
- **Playwright, [Best Practices § "Prefer user-facing attributes to XPath or
  CSS selectors"](https://playwright.dev/docs/best-practices#prefer-user-facing-attributes-to-xpath-or-css-selectors)**:
  "Your DOM can easily change so having your tests depend on your DOM
  structure can lead to failing tests."
- **Testing Library, [query priority](https://testing-library.com/docs/queries/about/#priority)**
  places `getByRole` at the top ("should be your top preference for just
  about everything") and `getByTestId` at the bottom ("only recommended for
  cases where you can't match by role or text or it doesn't make sense").
- **Testing Library, [Guiding Principles](https://testing-library.com/docs/guiding-principles/)**:
  "The more your tests resemble the way your software is used, the more
  confidence they can give you" — the underlying reasoning for preferring
  accessibility-tree/role-based selectors over implementation-detail
  selectors like CSS classes or component internals.
- **Cypress, [Best Practices § "Selecting Elements"](https://docs.cypress.io/app/core-concepts/best-practices#Selecting-Elements)**
  independently converges on the same rule for a non-role-based framework:
  "Add `data-*` attributes to make it easier to target elements," ranking
  `data-cy`/`data-test`/`data-testid` attributes as "Best. Isolated from all
  changes," and explicitly warning: "Don't target elements based on CSS
  attributes such as: `id`, `class`, `tag`."

### Wait/retry strategies

**Browser**

- Playwright's [Actionability](https://playwright.dev/docs/actionability)
  docs: "Playwright performs a range of actionability checks on the elements
  before making actions... It auto-waits for all the relevant checks to pass
  and only then performs the requested action." Checks include the element
  being Visible, Stable (not animating), Enabled, and Receiving Events.
- Playwright's [Test assertions](https://playwright.dev/docs/test-assertions)
  docs: "Playwright includes web-specific async matchers that will wait
  until the expected condition is met," retrying "until the condition is met
  or until the timeout is reached" (default 5s). Non-retrying assertions are
  explicitly warned against: "using non-retrying assertions can lead to a
  flaky test." For custom polling needs: `expect.poll` and `expect.toPass`.
- Playwright's API reference for `waitForLoadState`/`goto` marks
  `'networkidle'` as **DISCOURAGED**: "Don't use this method for testing,
  rely on web assertions to assess readiness instead" — a first-party
  statement that a global "network went quiet" signal is the wrong
  readiness proxy; wait on the specific state (element, response) the test
  actually needs.
- Cypress's [Retry-ability](https://docs.cypress.io/app/core-concepts/retry-ability)
  docs: "Retry-ability allows the test to complete each command as soon as
  the assertion passes, without hard-coding waits." Query commands (`.get()`,
  `.find()`) retry the entire chain with their assertion, re-querying the DOM
  on failure until timeout (default 4s): "If your application takes a few
  milliseconds or even seconds to render each DOM element — no big deal, the
  test does not have to change at all."

**API**

- The same auto-retrying-assertion mechanism (`expect.poll`, `expect.toPass`
  in Playwright) is the documented pattern for polling an assertion against
  an API response until it passes or a bound is hit — directly applicable to
  polling for eventual consistency (e.g. "has this async job finished
  processing yet?") instead of asserting once immediately after a request.
- Academically, Luo et al. FSE'14 name **Async Wait** as the single largest
  flaky-test category in their study (74/161 = 45% of root-caused commits):
  a test "makes an asynchronous call and does not properly wait for the
  result of the call to become available before using it." Their fix-type
  breakdown (Table 4) is the strongest available quantitative evidence for
  "poll, don't sleep": fixes using `waitFor`-style condition-waiting
  completely removed flakiness in 23/42 (55%) of cases, while fixes that
  used or adjusted a `sleep` delay only ever *decreased* flakiness
  probability, never eliminated it, because "sleep calls are only decreasing
  the chance of a flaky failure... running tests on different machines may
  make the sleep calls time out and trigger the flaky failures again."
  Measured average wait time was also longer and safer with `waitFor` (13.04s
  average) than with `sleep` (1.52s average) — because `waitFor` has "much
  higher upper bound," making it "more robust against flakiness."
- Google Testing Blog's ["Test Flakiness" post](https://testing.googleblog.com/2020/12/test-flakiness-one-of-main-challenges.html)
  frames the same problem as a "synchronization" discipline: the article
  describes needing to answer, for any state check, whether you're asking
  "does an object exist at this exact moment," "does an object exist within
  a maximum time, rechecking on this interval," etc. — i.e. bounded polling
  with an interval, not a fixed pause, as the general synchronization
  primitive underlying wait strategies at any test level.

**CLI**

- No test-framework-specific primary source (Playwright/Cypress/Testing
  Library are browser/DOM tools) or academic paper found that addresses CLI
  process testing specifically. This is a **caveat, not a fabricated
  citation**: the CLI rule above (wait on exit code / stdout marker, not a
  timer) is an extrapolation of the same principle established for
  browser/API levels — poll a concrete completion signal with a bounded
  timeout, never sleep a fixed duration — applied to the CLI-specific
  signals available (process exit code, a specific line appearing in
  stdout/stderr, a file/socket/lock appearing on disk). The generalized
  academic backing is that Luo et al.'s FSE'14 "Async Wait" category and its
  quantitative fix data (above) are language- and platform-agnostic: any
  process that starts something asynchronously (spawns a subprocess, starts
  a server, writes a file) and doesn't wait on a real completion signal is
  the same root cause, whether "the process" is a browser tab, an HTTP
  handler, or a CLI child process. `qa-generate` should treat this as a
  reasoned inference, not an authoritative doc citation, when it documents
  the rule to users.

### Test-data isolation

**Framework docs (mostly browser-oriented, but the pattern generalizes)**

- Playwright's [Best Practices § "Make tests as isolated as possible"](https://playwright.dev/docs/best-practices#make-tests-as-isolated-as-possible):
  "Each test should be completely isolated from another test and should run
  independently with its own local storage, session storage, data, cookies
  etc." — using `beforeEach` for setup so state doesn't leak between tests.
- Playwright's [Test fixtures](https://playwright.dev/docs/test-fixtures)
  docs: fixtures are test-scoped by default and "torn down after each
  test," while worker-scoped fixtures persist per worker process — the
  scoping mechanism that prevents accidental cross-test state sharing.
- Cypress's [Test Isolation](https://docs.cypress.io/app/core-concepts/test-isolation)
  docs: "Tests should always be able to be run independently from one
  another and still pass." With test isolation enabled, Cypress clears DOM
  state (navigates to `about:blank`), cookies, `localStorage`, and
  `sessionStorage` before each test specifically to prevent "nondeterministic
  test failures which make debugging challenging."
- Cypress's [Best Practices § "Having Tests Rely On The State Of Previous
  Tests"](https://docs.cypress.io/app/core-concepts/best-practices#Having-Tests-Rely-On-The-State-Of-Previous-Tests)
  gives a concrete self-check: run the suspect test with `.only()` — if it
  fails in isolation, it was improperly order-coupled. It also recommends
  putting state reset in `beforeEach` rather than `afterEach`: "State reset
  should go before each test," because a hook that runs *before* the next
  test executes regardless of whether the previous test crashed, whereas an
  `afterEach` may be skipped if the run is interrupted.

**Academic flaky-test taxonomies naming order-dependence/unmanaged state**

- Luo et al., [FSE'14](https://mir.cs.illinois.edu/lamyaa/publications/fse14.pdf),
  name **Test Order Dependency** as one of their 10 root-cause categories
  (19/161 = 12% of studied commits, one of the top three categories
  alongside Async Wait and Concurrency): "the test outcome depends on the
  order in which the tests are run... this problem arises when the tests
  depend on a shared state that is not properly setup or cleaned." They
  further split the source of the shared state into three subcategories:
  static field in the test code, static field in the code-under-test, and
  external dependency (shared file/network port/database) — direct
  motivation for `qa-generate` to isolate not just in-test-process state but
  any file/DB/network resource a generated test touches. Their fix data
  shows 74% of Test Order Dependency fixes work "by cleaning the shared
  state between test runs" (`setUp`/`tearDown`), reinforcing rule #11/#12
  above.
- Lam et al., [ISSTA'19, "Root Causing Flaky Tests in a Large-Scale
  Industrial Setting"](https://mir.cs.illinois.edu/winglam/publications/2019/LamETAL19RootFinder.pdf)
  (Microsoft), corroborate the same taxonomy in production: their case
  studies include a **Time** flaky test (two services computing
  `DateTime.UtcNow` independently and occasionally landing on different
  second boundaries) and a **Randomness** flaky test (two `Random`
  instances seeded from a system clock close enough together to produce
  identical output) — both root causes only manifest because the test
  didn't isolate/inject that non-deterministic input per run. They also cite
  a keynote figure that "1.5% of all test runs in Google's CI pipeline are
  flaky," underscoring the scale of the problem industry-wide.
- Google Testing Blog, ["Test Sizes"](https://testing.googleblog.com/2010/12/test-sizes.html):
  Google's own constraint set requires that "tests can be run in any order
  (they frequently are!) which in turn means that tests need high isolation
  — you can't rely on some other test leaving data behind." This is
  presented as a hard organizational rule, not just a stylistic preference,
  because it's what makes parallel test execution safe.

## Sources

- Playwright — [Best Practices](https://playwright.dev/docs/best-practices)
- Playwright — [Locators](https://playwright.dev/docs/locators)
- Playwright — [Actionability](https://playwright.dev/docs/actionability)
- Playwright — [Test assertions](https://playwright.dev/docs/test-assertions)
- Playwright — [Mock APIs](https://playwright.dev/docs/mock)
- Playwright — [Clock](https://playwright.dev/docs/clock)
- Playwright — [Test fixtures](https://playwright.dev/docs/test-fixtures)
- Playwright — API reference, `waitForLoadState`/`goto` (`networkidle` DISCOURAGED note), https://playwright.dev/docs/api/class-page#page-wait-for-load-state
- Cypress — [Best Practices](https://docs.cypress.io/app/core-concepts/best-practices)
- Cypress — [Network Requests](https://docs.cypress.io/app/guides/network-requests)
- Cypress — [Retry-ability](https://docs.cypress.io/app/core-concepts/retry-ability)
- Cypress — [Test Isolation](https://docs.cypress.io/app/core-concepts/test-isolation)
- Testing Library — [Queries: Priority](https://testing-library.com/docs/queries/about/#priority)
- Testing Library — [Guiding Principles](https://testing-library.com/docs/guiding-principles/)
- Google Testing Blog — Simon Stewart, ["Test Sizes"](https://testing.googleblog.com/2010/12/test-sizes.html) (2010)
- Google Testing Blog — ["Test Flakiness — One of the main challenges of automated testing"](https://testing.googleblog.com/2020/12/test-flakiness-one-of-main-challenges.html) (2020)
- Google Testing Blog — ["Where do our flaky tests come from?"](https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html) (2017)
- Google Testing Blog — ["Flaky Tests at Google and How We Mitigate Them"](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html) (2016)
- Microsoft Engineering — ["Improving developer productivity via flaky test management"](https://devblogs.microsoft.com/engineering-at-microsoft/improving-developer-productivity-via-flaky-test-management/)
- Luo, Hariri, Eloussi, Marinov — ["An Empirical Analysis of Flaky Tests"](https://mir.cs.illinois.edu/lamyaa/publications/fse14.pdf), FSE 2014
- Lam, Godefroid, Nath, Santhiar, Thummalapenta — ["Root Causing Flaky Tests in a Large-Scale Industrial Setting"](https://mir.cs.illinois.edu/winglam/publications/2019/LamETAL19RootFinder.pdf), ISSTA 2019

### Sources checked but not usable

- No CLI-specific primary source (framework doc, engineering blog, or
  academic paper) was found addressing process/CLI-level test flakiness
  directly; the CLI wait/retry rule in this document is flagged as an
  extrapolation rather than a direct citation (see "Wait/Retry Strategies —
  CLI" above).
- `docs.cypress.io/app/references/best-practices` returned HTTP 404 — the
  correct current URL is `docs.cypress.io/app/core-concepts/best-practices`,
  used above instead.
