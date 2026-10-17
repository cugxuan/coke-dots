# Browser Use Pi

`browser-use-pi-e73c28b.tgz` is an unmodified build of
[browser-use/browser-use-pi](https://github.com/browser-use/browser-use-pi/tree/e73c28b87998afddc168951b3f768a3f0e81d640),
commit `e73c28b87998afddc168951b3f768a3f0e81d640`, MIT licensed (LICENSE included).

The published 0.1.0 package lacks `close({keepTabs:true})`. Closing its executor
would close user-visible tabs created during a task. This pinned upstream commit
supports preserving those tabs. Installing the Git dependency with our required
`--ignore-scripts` produces a package without `dist`; the prebuilt archive makes
both control-plane and desktop-image installs independent of lifecycle scripts.

Rebuild from a clean upstream checkout at that commit with `npm ci --ignore-scripts`,
`npm run build`, then `npm pack --ignore-scripts`. Check the source revision and
archive contents before updating the lockfile. No upstream source changes are
applied. The archive includes upstream source maps and license.

Archive SHA-256: `2cdaa1ef277aa9700a23c4893d9cc73f6e2d95126cd4382e3f2d9711211f6b80`.

Coke Dots uses only `BrowserUse.create/execute/close` as a persistent JavaScript
executor. The existing Pi session remains the sole model loop. Anonymous telemetry
is disabled, provider credentials never enter the execution worker, and the
connection always targets the existing tenant Chromium. Runtime helpers use
Playwright for observed-element actions and Browser Use for CDP, tab identity,
execution cancellation and full-output evidence.
