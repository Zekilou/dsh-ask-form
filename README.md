# dsh-ask-form

A community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that lets the model ask **structured questions as one form** — typed fields, conditions, validation and targeted re-asks — and receive typed JSON answers.

The built-in `ask_user_question` tool is a flat option list shown one question per page. `ask_form` adds field types, cross-field constraints and a single submission, and it **degrades to the built-in flow** on any surface that cannot render it.

English | [中文](README.zh.md)

## Features

- **14 field types** — `confirm`, `single`, `multi`, `text`, `longtext`, `number`, `integer`, `date`, `tags`, `scale`, `slider`, `ranking`, `matrix`, `budget`
- **Conditions and validation** — `visible_if`, `validate` (a whitelisted expression language, never `eval`), `pattern`, `max_length`, `min`/`max`, `sum_to`
- **Targeted re-asks** — only the fields that failed validation are asked again, up to `max_rounds`
- **Typed results** — `scale`/`slider`/`number` → number, `ranking` → ordered array, `matrix` → `{row: choice}`, `budget` → `{option: number}`, `tags` → string array
- **Interview packs** — `requirement-intake`, `design-choice`, `release-gate`, `incident-intake`, tunable through `pack_args`
- **Free-text "Other" by default** on `single`, `multi` and `tags` (`allow_other: false` closes the list). The whole row is the target: clicking it focuses the field, typing selects it on `single`, Enter turns it into a removable chip on `multi`/`tags`.
- **Escape hatch (opt-in)** — `mode: "script"` renders a custom React element, but only on a page that sets `window.__DSH_ASK_FORM_SCRIPT__ = true`: arbitrary JS can freeze the tab and nothing in a browser can interrupt it. Declare `script.fallback` for other surfaces
- **Graceful degradation** — a surface without this plugin's renderer still receives every field as a plain question, and the result reports `renderer: "generic"`. Script mode fails loud instead of degrading silently.

## Install

Prerequisites: a Harness profile with the `plugin_manager` tool (the `web` profile has it).

1. Install the bundle — ask the agent in the Harness, or run the `plugin_manager` tool with:

   ```
   action: install_bundle
   target: github:Zekilou/dsh-ask-form
   ```

   From a local clone, pass its absolute path instead: `/absolute/path/to/dsh-ask-form`.

2. Reload the Harness Web page once, so the client bundle registers (`client.js` owns the form surface).
3. The `ask_form` tool is now available next to `ask_user_question`.

## Usage

A form is one tool call. Fields are ordered; the first option of a list is the recommended one by convention.

```json
{
  "title": "Runtime decision",
  "intro": "Pick the runtime and weight the criteria.",
  "fields": [
    { "name": "runtime", "type": "single", "label": "Runtime",
      "options": ["Node 22 (Recommended)", "Bun", "Deno"] },
    { "name": "needs_wasm", "type": "confirm", "label": "Do you need WASM?",
      "visible_if": "runtime == 'Bun'" },
    { "name": "weights", "type": "budget", "label": "Criteria weights (sum 100)",
      "options": ["Performance", "Ecosystem", "Footprint"], "sum_to": 100 },
    { "name": "priority", "type": "ranking", "label": "Priority order",
      "options": ["Ship fast", "Stay small", "Be portable"] },
    { "name": "scores", "type": "matrix", "label": "Score each dimension",
      "rows": ["Performance", "Cost"], "options": ["High", "Medium", "Low"] }
  ],
  "notes": true
}
```

A ready-made interview:

```json
{ "pack": "requirement-intake", "pack_args": { "topic": "cache layer" }, "notes": true }
```

The result carries typed values plus provenance:

```json
{ "status": "answered", "rounds": 1, "renderer": "form",
  "values": { "runtime": "Bun", "needs_wasm": true,
              "weights": { "Performance": 50, "Ecosystem": 30, "Footprint": 20 },
              "priority": ["Be portable", "Ship fast", "Stay small"],
              "scores": { "Performance": "High", "Cost": "Low" } },
  "notes": "…" }
```

`status` is one of `answered`, `incomplete`, `cancelled`, `aborted`, `no_answerer`, `unavailable`, `script_error`.

## How it works

The bundle has two halves and no build step.

**Host half (`index.js`)** registers the `ask_form` tool over the existing `ctx.userQuestions` seam. It compiles the typed form into ordinary `AskUserQuestionItem[]` — so any answerer can still answer it — and carries the rich spec to its own renderer through the marker item's `intent`. Afterwards it decodes either the renderer's JSON envelope or plain option/label answers, validates on the Host, and re-asks only the failures.

**Client half (`client.js`)** registers one low-priority entry in the `conversation.composer` chain. It claims a pending request only when a question carries this plugin's `intent.kind`, renders the whole form as a centered floating layer (`react-dom` portal, native modal geometry), and answers with the JSON envelope. Every other pending request — including plan reviews — returns `null` and stays with the shipped composer, so installing this bundle cannot change the built-in flow.

Notable behaviours:

- **Lossless wire payload** — the spec must survive a JSON round trip unchanged; a present-but-`undefined` property makes the Remote event gateway reject the whole request.
- **Self-probe (opt-in)** — set `window.__DSH_ASK_FORM_PROBE__ = true`, then a form titled `DSH_ASK_FORM_PROBE` answers itself with a DOM report (card rect, computed styles, `elementFromPoint` hit tests). Off by default: a form that answers itself is a hazard, not a feature.
- **Non-blocking surface** — the overlay never captures the whole viewport: background clicks pass through, the card stays below app dialogs, and every exit path works offline.
- **Fail-safe registration** — the bundle registers inside `try`/`catch` and checks that the slot chain exists; a broken registration costs the form surface, never the page.
- **One stylesheet per document** — styles live on `document.head`, not in the rendered tree, so the script and error surfaces are styled even when they are the first thing on screen.
- **Watchdog** — if an answer never reaches the Host within 10 seconds (a suspended or replaced connection), the buttons re-enable with an explicit message instead of hanging.
- **bfcache banner** — a page restored from the back/forward cache lost the socket that carried the request; the card says so instead of ignoring clicks.

## Verify

Three standalone suites, no monorepo install and no browser needed:

```sh
node tests/host.test.mjs          # compile -> decode -> validate -> rounds -> cancellation
node tests/client.test.mjs         # render tree, marker selector, submit envelope
node tests/interaction.test.mjs    # real state: typing, Enter, chips, blur races, steps
```

The first drives the Host half against scripted answerers. The other two drive the real component
tree: `client.test.mjs` on stateless hook stubs (structure and protocol), `interaction.test.mjs`
on a small hook runtime with real `useState`/`useRef`/`useEffect`, so a handler can be fired and
the following render inspected — that is how the free-text "other" row, the numeric field and the
tag blur race are covered. Both read the bundle id from `package.json`, so a rename cannot
desynchronise them.

Layout, focus and hit-testing need a browser. `tests/lab/` is an offline lab that serves the real
`client.js` with the real Host-compiled payload and React 18 from `tests/lab/vendor/`:

```sh
node tests/lab/serve.mjs --port 7321                 # then open http://127.0.0.1:7321/?form=single
node tests/lab/browser.mjs http://127.0.0.1:7321     # real clicks, real keystrokes, hit tests
node tests/lab/shots.mjs   http://127.0.0.1:7321     # before/after screenshots (?client=old)
```

Before/after of the free-text row (old bundle vs. 0.5.0): [before](docs/shots/before-single.png) · [after](docs/shots/after-single.png), [multi before](docs/shots/before-multi.png) · [multi after](docs/shots/after-multi.png)

`browser.mjs` needs `playwright-core` resolvable from its directory; run it next to an installed
`node_modules`, on a machine whose screen nobody is using.

## Compatibility

- Host half needs `ctx.tools` and `ctx.userQuestions`.
- Client half needs the `conversation.composer` chain and `react-dom` as a shell seed word (both present in the Web app).
- Written against the pre-stable `@deepseek-ai/dsh-*` packages of the `0.2.0-rc.2` era; those APIs may move.

## Deliberate deviations from the shipped question card

- The form is a **centered panel**, not a composer-seat takeover. It is a *positioning* layer
  only: the frame is `pointer-events:none` and sits below the app's own dialogs, so an approval
  prompt or a settings dialog can never end up underneath it.
- **A form can never take the page hostage.** Escape closes it, `取消` and the close button are
  live even while a submit is in flight, and closing is a *local* operation — one dropped socket
  cannot leave a full-page layer with no way out. Closing also answers `cancelled` on a
  best-effort basis, and drafts are keyed by form so a re-ask restores what was typed.

## Attribution

The client-side styles are adapted from MIT-licensed Harness client packages, with class names renamed under this plugin's prefix:

- `@deepseek-ai/dsh-client-ui-primitives` — `Button`, `Input`, `Tag`, `SegmentedControl`, `Modal` geometry
- `@deepseek-ai/dsh-client-ui-user-questions` — the question card structure, option rows, recommendation badge

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT — see [LICENSE](LICENSE).
