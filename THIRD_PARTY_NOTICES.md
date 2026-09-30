# Third-party notices

This project is MIT-licensed (see [LICENSE](LICENSE)). Its client-side presentation is adapted
from MIT-licensed packages of the DeepSeek Harness repository
(<https://github.com/deepseek-ai/deepseek-harness>), as recorded below. No Harness package is
imported as a module: the copied material is CSS declarations, element structure and geometry,
with every class name renamed under this plugin's `daf-` prefix.

## @deepseek-ai/dsh-client-ui-primitives

- License: MIT
- Source: `packages/client/ui-primitives/`
- Used for: control geometry and colours of `Button` (md, primary/outline/ghost), `Input`
  (32px field, `0.5px` border, focus-within stroke), `Tag` (capsule, 11px), `SegmentedControl`
  (track, 28px tabs, selected pill) and the `Modal` overlay layer (`position: fixed`, `inset: 0`,
  `z-index: 1000`, `pointer-events`, mask, `--dsh-frame-top-clearance` padding,
  `--dsw-radius-panel`, `--dsw-elevation-prominent`).

## @deepseek-ai/dsh-client-ui-user-questions

- License: MIT
- Source: `packages/client/ui-user-questions/`
- Used for: the question card structure (frame, card, header, eyebrow, title, detail, body,
  footer, feedback) and the option row (numbered box for single-select, checkbox for
  multi-select, option copy, recommendation badge, description).

Both packages are published by DeepSeek under the MIT license; their copyright notice is
reproduced by the Harness repository at <https://github.com/deepseek-ai/deepseek-harness>.
