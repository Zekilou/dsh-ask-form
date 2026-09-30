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
- **Free-text "Other" by default** on `single`, `multi` and `tags` (`allow_other: false` closes the list)
- **Escape hatch** — `mode: "script"` renders a custom React element in the Web UI; declare `script.fallback` for other surfaces
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
- **Self-probe** — a form titled `DSH_ASK_FORM_PROBE` is answered automatically with a DOM report (card rect, computed styles, `elementFromPoint` hit tests). It is how this plugin was debugged without browser automation, and it stays useful for diagnosing a broken surface.
- **Watchdog** — if an answer never reaches the Host within 10 seconds (a suspended or replaced connection), the buttons re-enable with an explicit message instead of hanging.
- **bfcache banner** — a page restored from the back/forward cache lost the socket that carried the request; the card says so instead of ignoring clicks.

## Verify

Two standalone suites, no monorepo install and no browser needed:

```sh
node tests/host.test.mjs     # compile -> decode -> validate -> rounds -> cancellation
node tests/client.test.mjs   # render tree, marker selector, submit envelope
```

They stub React (the page provides the real one) and drive the real component tree, so they assert structure and protocol, not pixels. `tests/client.test.mjs` reads the bundle id from `package.json`, so a rename cannot desynchronise them.

## Compatibility

- Host half needs `ctx.tools` and `ctx.userQuestions`.
- Client half needs the `conversation.composer` chain and `react-dom` as a shell seed word (both present in the Web app).
- Written against the pre-stable `@deepseek-ai/dsh-*` packages of the `0.2.0-rc.2` era; those APIs may move.

## Deliberate deviations from the shipped question card

- The layer is a **centered modal with a mask**, not a composer-seat takeover.
- Clicking the mask does not dismiss, and Escape does not cancel, so a half-filled form cannot be lost by a stray click.

## Attribution

The client-side styles are adapted from MIT-licensed Harness client packages, with class names renamed under this plugin's prefix:

- `@deepseek-ai/dsh-client-ui-primitives` — `Button`, `Input`, `Tag`, `SegmentedControl`, `Modal` geometry
- `@deepseek-ai/dsh-client-ui-user-questions` — the question card structure, option rows, recommendation badge

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT — see [LICENSE](LICENSE).
