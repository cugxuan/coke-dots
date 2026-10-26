# SSE search and browser readiness

The 2026-10-26 BYD trace sent `searchword` to SSE's `getESSearchDoc.do`, while the current website sets `keyword`, `keywordPosition` and `siteName`. The endpoint returned HTTP 200 and unrelated announcements, so transport success did not establish an effective search. The task also spent 44 seconds in fixed browser sleeps.

The desktop now includes `node /opt/coke-dots/sse-search.mjs --keyword "比亚迪 公司债券" --limit 10`. It requests only SSE's public search endpoint, validates HTTP and business results, normalizes source URLs, removes duplicate documents and does not retry errors. `--page` starts at zero; `--mode` and `--sort` support the website's search modes. Returned rows are search metadata, not independently verified documents. Reported totals may be capped. Source scope and a user's browser-only requirement still apply. Historical task scripts and outputs are preserved.

Browser helpers accept an optional `waitFor` condition on `goto`, `open`, `click`, `fill`, `select`, `check` and `press`. For example, `await ui.click(observedId, {waitFor:{text:"Result: this-query", timeoutMs:10000}})` performs the action once and waits until that result appears. A timeout preserves the action's effects and must not cause a replay. Conditions are validated before the action. Existing calls and `ui.waitFor` remain compatible.

Choose conditions from observed page structure or the requested result. For asynchronous refreshes, an old result list being visible does not prove the new query completed. When a specific response is needed, register Playwright's response wait before performing the action.

The first production retest showed that guidance alone did not prevent raw Playwright sleeps. The executor now rejects `Page.waitForTimeout` and cell-level `setTimeout` delays of at least 200ms, with an actionable readiness error. It leaves Node/Playwright's internal timers and page scripts intact. A per-call `waitReason` permits observations explicitly timed by the user; it resets on the next call. This is an efficiency rule, not a security boundary against arbitrary JavaScript or shell code.
