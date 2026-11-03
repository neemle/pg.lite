# Use cases of the browser module and its demo

The use cases that the UI tests of `tools/tests/browser/demo.spec.ts` cover. Every test carries its `[UC-###]` in the title, and every
use case has at least one test with a recorded video (see "Evidence"). The tests that call the page API without a user interface
(`engine.spec.ts`, `persistence.spec.ts`) cover the requirements W01 to W09 of the engine and are not use cases of a user.

| ID | Use case | Test |
| --- | --- | --- |
| UC-001 | A person opens the app: PostgreSQL starts in the browser, TypeORM creates the schema, the app shows the server version and an empty list. | `[UC-001] the app starts PostgreSQL in the browser and TypeORM creates the schema` |
| UC-002 | A person adds notes with categories, marks one done, reloads the page and removes a note: everything is kept in the browser database. | `[UC-002] notes and categories are saved through TypeORM and survive a reload` |
| UC-003 | A person runs SQL in the console: exact numbers come back as text, errors show their SQLSTATE, transaction control outside a transaction handle is refused. | `[UC-003] the SQL console shows exact values and SQLSTATE errors` |
| UC-004 | A person opens the app in a second tab while the first one has the database open: the second tab says that the database is in use, the first tab keeps working. | `[UC-004] a second tab gets a clear "in use" error instead of a second engine` |
| UC-005 | A person installs the app for offline use, stops the server and the network, reloads, adds a note and reloads again: the data is there. | `[UC-005] the app is installed for offline use, then works with the server stopped and the network off` |

## Evidence

Every run of `./builder.sh test <version> wasm` writes into `tools/reports/browser/` (`BROWSER_REPORT_DIR` changes the place):

* `report/` the HTML report of the run, with the steps and their screenshots of every test;
* `results/<test>/` a video of the test in Full HD (1920x1080, the cursor and the clicks are visible), the screenshots, and for a failed
  test the execution trace.

Interaction is at the speed of a person (one shared helper, `tools/tests/browser/ui.ts`): keys at 400 ms, 400 ms around a click,
a second after a navigation.
