/**
 * Client half of `@zekilou/dsh-ask-form`.
 *
 * Registers one low-priority entry in the `conversation.composer` chain: it claims a pending
 * question carrier only when one of its questions carries this plugin's `intent.kind`, renders
 * the whole form on one page, and answers with a JSON envelope in the answer's `custom` field.
 * Every other pending request (including plan reviews) returns `null` and stays with the packed
 * question composer, so shipping this bundle cannot change the stock flow.
 *
 * Constraints honored here:
 * - No Harness Client package is imported; `react` is a platform seed word and everything else
 *   (stylesheet, controls, icons) is local.
 * - Styles use `--dsw-alias-*` theme tokens only, so light/dark switching is inherited.
 * - All resources are registered in `apply` through `ctx.slots`, and the component keeps its
 *   own state, so unloading the plugin removes everything it contributed.
 */

window.__ModuleLoader__.load({
  id: '@zekilou/dsh-ask-form',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    /** `react-dom` is a shell seed word (React 18), so a body-level portal needs no bundling. */
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch { ReactDOM = null; }

    /** Reported by the Client half so a live page can be identified from a screenshot or a probe. */
    const CLIENT_VERSION = '0.4.0';
    /** Magic title: the Client reports a DOM probe and answers immediately instead of waiting for input. */
    const PROBE_TITLE = 'DSH_ASK_FORM_PROBE';

    /** Marker tag shared with the Host half. */
    const MARKER_KIND = 'dsh-form';
    /** Answer-envelope sentinel; must match the Host half byte for byte. */
    const ENVELOPE_PREFIX = '\u0001dsh-form:';
    /** Drafts survive this many pending carriers inside one page session. */
    const DRAFT_LIMIT = 8;

    const CSS = `
.daf-frame{position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-top-clearance,24px)) 24px;display:flex}
.daf-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgb(0 0 0/.32));backdrop-filter:var(--dsw-mask-blur,none);animation:dafFade var(--ds-transition-duration,160ms) var(--ds-ease-in-out,ease)}
.daf-card{position:relative;z-index:1;width:min(800px,100%);max-height:min(60vh,560px);flex-direction:column;display:flex;overflow:hidden;padding:0 0 12px;border:0;border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent,0 16px 48px rgb(0 0 0/.24));color:var(--dsw-alias-label-primary);animation:dafFade var(--ds-transition-duration,160ms) var(--ds-ease-in-out,ease);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
@keyframes dafFade{from{opacity:0}to{opacity:1}}
.daf-card,.daf-card *{box-sizing:border-box}
.daf-header{flex-shrink:0;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 16px 0 24px;display:flex}
.daf-headingBlock{min-width:0}
.daf-headerActions{flex-shrink:0;align-items:center;gap:4px;display:flex}
.daf-eyebrow{color:var(--dsw-alias-label-tertiary);margin-bottom:5px;font-size:11px;line-height:16px}
.daf-title{margin:0;font-size:16px;font-weight:500;line-height:22px}
.daf-detail{margin:0 2px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:pre-wrap}
.daf-body{overscroll-behavior:contain;flex-direction:column;flex:auto;min-height:0;display:flex;overflow-y:auto}
.daf-fields{flex-direction:column;gap:18px;margin:10px 0 0;padding:4px 12px 0;display:flex}
.daf-field{flex-direction:column;gap:6px;display:flex}
.daf-sub{flex-direction:column;gap:6px;display:flex}
.daf-label{font-size:13px;font-weight:500;line-height:20px}
.daf-req{color:var(--dsw-alias-state-error-primary);margin-left:4px}
.daf-help{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:pre-wrap}
.daf-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-wrap}
.daf-options{flex-direction:column;gap:1px;display:flex}
.daf-option{width:100%;min-height:40px;flex-shrink:0;align-items:flex-start;gap:8px;padding:8px 12px 8px 8px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);transition:background-color .12s,border-color .12s;display:flex}
.daf-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.daf-optionSelected{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-border-l2)}
.daf-option:disabled{cursor:default;opacity:.6}
.daf-number{width:20px;height:20px;flex:0 0 20px;margin-top:2px;place-items:center;display:grid;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.daf-checkbox{width:20px;height:20px;flex:0 0 20px;margin-top:2px;place-items:center;display:grid}
.daf-checkbox:before{content:"";grid-area:1/1;width:14px;height:14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-xs,4px);transition:background-color .12s,border-color .12s}
.daf-checkbox>svg{grid-area:1/1}
.daf-checkboxChecked{color:var(--dsw-alias-label-primary-foreground,#fff)}
.daf-checkboxChecked:before{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary)}
.daf-optionCopy{flex:1;min-width:0}
.daf-optionLine{flex-wrap:wrap;align-items:baseline;gap:2px 6px;display:flex}
.daf-optionLabel{font-size:14px;font-weight:500;line-height:24px}
.daf-badge{padding:0 4px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-specific-sidebar-nav-item-active-accent,var(--dsw-alias-bg-overlay));color:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary));font-size:11px;font-weight:600;line-height:18px}
.daf-description{color:var(--dsw-alias-label-tertiary);font-size:14px;font-weight:400;line-height:24px}
.daf-inputWrap{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1)}
.daf-inputWrap:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.daf-inputWrap:focus-within,.daf-textareaBlock:focus-within{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.daf-input{flex:1;min-width:0;padding:0;border:none;outline:none;background:transparent;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.daf-input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}
.daf-invalid{border-color:var(--dsw-alias-state-error-primary)}
.daf-textareaBlock{display:flex;min-height:64px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-module-platform)}
.daf-textarea{width:100%;min-height:48px;resize:vertical;border:none;outline:none;background:transparent;font:inherit;font-size:14px;line-height:24px;color:var(--dsw-alias-label-primary)}
.daf-textarea::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}
.daf-segmentedTrack{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.daf-segment{position:relative;z-index:1;height:28px;padding:0 14px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;transition:color .12s,background-color .12s,box-shadow .12s}
.daf-segment:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.daf-segmentOn,.daf-segmentOn:hover{background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgb(0 0 0/.12));color:var(--dsw-alias-label-primary)}
.daf-segment:disabled{cursor:default;opacity:.4}
.daf-segment:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.daf-anchors{display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.daf-range{width:100%;accent-color:var(--dsw-alias-brand-primary)}
.daf-matrix{display:flex;flex-direction:column;gap:6px}
.daf-matrixRow{display:flex;align-items:center;gap:8px}
.daf-matrixLabel{flex:0 0 104px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.daf-gridHead{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-align:center}
.daf-tagBox{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:5px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1)}
.daf-tagBox:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.daf-tag{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.daf-tagX{display:inline-flex;align-items:center;padding:0;border:none;background:transparent;color:inherit;cursor:pointer}
.daf-tagInput{flex:1;min-width:120px;padding:0;border:none;outline:none;background:transparent;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.daf-rank{display:flex;flex-direction:column;gap:1px}
.daf-rankRow{display:flex;align-items:center;gap:8px;min-height:40px;padding:6px 8px;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px)}
.daf-rankRow:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.daf-rankIndex{width:20px;height:20px;flex:0 0 20px;place-items:center;display:grid;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.daf-rankLabel{flex:1;min-width:0;font-size:14px;font-weight:500;line-height:24px}
.daf-budget{display:flex;flex-direction:column;gap:8px}
.daf-budgetRow{display:flex;align-items:center;gap:8px}
.daf-budgetName{flex:0 0 96px;font-size:14px;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.daf-budgetInput{width:96px;flex:0 0 96px}
.daf-bar{flex:1;height:6px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}
.daf-barFill{height:100%;background:var(--dsw-alias-brand-primary)}
.daf-total{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.daf-linkBtn{align-self:flex-start;padding:0;border:none;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.daf-footer{flex-shrink:0;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;padding:0 10px 0 18px;display:flex}
.daf-feedback{min-height:16px;flex:1;color:var(--dsw-alias-state-error-primary);text-align:right;font-size:11px;line-height:16px}
.daf-footerActions{flex-shrink:0;align-items:center;gap:12px;display:flex}
.daf-pager{flex-shrink:0;align-items:center;gap:6px;display:flex}
.daf-progress{color:var(--dsw-alias-label-secondary);white-space:nowrap;word-spacing:-2px;padding:0 4px;font-size:14px;font-weight:500;line-height:24px}
.daf-button{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,8px);cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}
.daf-button:disabled{cursor:not-allowed;opacity:.4}
.daf-buttonPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.daf-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.daf-buttonOutline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}
.daf-buttonOutline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.daf-buttonGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.daf-buttonGhost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-2))}
.daf-button:focus-visible,.daf-iconButton:focus-visible,.daf-close:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.daf-close{flex:none;width:28px;height:28px;place-items:center;display:grid;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.daf-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3))}
.daf-close:disabled{opacity:.4;cursor:default}
.daf-iconButton{width:24px;height:24px;place-items:center;display:grid;padding:0;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.daf-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.daf-iconButton:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));cursor:default}
.daf-stack{max-height:180px;margin:0;padding:8px 10px;overflow:auto;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap}
@media (width<=720px){.daf-card{border-radius:var(--dsw-radius-xl,16px)}.daf-header{padding:10px 12px 0 18px}.daf-fields{padding:4px 8px 0}.daf-option,.daf-rankRow{padding:8px 6px}.daf-footer{align-items:flex-end;padding:0 10px}.daf-matrixLabel{flex-basis:84px}}
@media (prefers-reduced-motion:reduce){.daf-option,.daf-segment{transition:none}.daf-card{animation:none}}
`;

    /* ------------------------------------------------------------------ */
    /* expression evaluator (L2) — mirror of the Host half                 */
    /* ------------------------------------------------------------------ */

    const EXPRESSION_FUNCTIONS = {
      len: (v) => (typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0),
      count: (v) => (Array.isArray(v) ? v.filter((item) => !isBlank(item)).length : isBlank(v) ? 0 : 1),
      sum: (v) => {
        const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [v];
        return list.reduce((total, item) => total + (Number(item) || 0), 0);
      },
      round: (v, digits) => {
        const factor = 10 ** (Number(digits) || 0);
        return Math.round(Number(v) * factor) / factor;
      },
      min: (...args) => Math.min(...args.flat().map(Number)),
      max: (...args) => Math.max(...args.flat().map(Number)),
      abs: (v) => Math.abs(Number(v)),
      floor: (v) => Math.floor(Number(v)),
      ceil: (v) => Math.ceil(Number(v)),
      num: (v) => (v === '' || v === null || v === undefined ? Number.NaN : Number(v)),
      str: (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v)),
      lower: (v) => String(v ?? '').toLowerCase(),
      upper: (v) => String(v ?? '').toUpperCase(),
      empty: (v) => isBlank(v),
      contains: (haystack, needle) =>
        typeof haystack === 'string'
          ? haystack.includes(String(needle))
          : Array.isArray(haystack)
            ? haystack.some((item) => item === needle || String(item) === String(needle))
            : false,
    };

    function tokenize(source) {
      const tokens = [];
      let index = 0;
      while (index < source.length) {
        const char = source[index];
        if (/\s/.test(char)) { index += 1; continue; }
        if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
          let end = index;
          while (end < source.length && /[0-9.]/.test(source[end])) end += 1;
          tokens.push({ type: 'number', value: Number(source.slice(index, end)) });
          index = end;
          continue;
        }
        if (char === '"' || char === "'") {
          let end = index + 1;
          let text = '';
          while (end < source.length && source[end] !== char) {
            if (source[end] === '\\') end += 1;
            text += source[end];
            end += 1;
          }
          if (end >= source.length) throw new Error(`unterminated string literal in ${JSON.stringify(source)}`);
          tokens.push({ type: 'string', value: text });
          index = end + 1;
          continue;
        }
        if (/[A-Za-z_$]/.test(char)) {
          let end = index;
          while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
          tokens.push({ type: 'ident', value: source.slice(index, end) });
          index = end;
          continue;
        }
        const pair = source.slice(index, index + 2);
        if (['==', '!=', '<=', '>=', '&&', '||'].includes(pair)) { tokens.push({ type: 'op', value: pair }); index += 2; continue; }
        if ('+-*/%()!,<>'.includes(char)) { tokens.push({ type: 'op', value: char }); index += 1; continue; }
        throw new Error(`unexpected character ${JSON.stringify(char)} in ${JSON.stringify(source)}`);
      }
      return tokens;
    }

    function compileExpression(source) {
      const tokens = tokenize(source);
      let position = 0;
      const peek = () => tokens[position];
      const eat = (value) => {
        const token = tokens[position];
        if (token !== undefined && token.type === 'op' && token.value === value) { position += 1; return true; }
        return false;
      };
      const expect = (value) => { if (!eat(value)) throw new Error(`expected ${JSON.stringify(value)} in ${JSON.stringify(source)}`); };

      function parsePrimary() {
        const token = peek();
        if (token === undefined) throw new Error(`unexpected end of expression ${JSON.stringify(source)}`);
        if (token.type === 'number' || token.type === 'string') { position += 1; return () => token.value; }
        if (token.type === 'ident') {
          position += 1;
          if (token.value === 'true') return () => true;
          if (token.value === 'false') return () => false;
          if (token.value === 'null') return () => null;
          if (eat('(')) {
            const args = [];
            if (!eat(')')) {
              for (;;) {
                args.push(parseOr());
                if (eat(',')) continue;
                expect(')');
                break;
              }
            }
            const fn = EXPRESSION_FUNCTIONS[token.value];
            if (fn === undefined) throw new Error(`unknown function ${JSON.stringify(token.value)} in ${JSON.stringify(source)}`);
            return (scope) => fn(...args.map((arg) => arg(scope)));
          }
          const name = token.value;
          return (scope) => (scope === null || scope === undefined ? undefined : scope[name]);
        }
        if (eat('(')) { const inner = parseOr(); expect(')'); return inner; }
        throw new Error(`unexpected token ${JSON.stringify(token.value)} in ${JSON.stringify(source)}`);
      }

      function parseUnary() {
        if (eat('!')) { const operand = parseUnary(); return (scope) => !truthy(operand(scope)); }
        if (eat('-')) { const operand = parseUnary(); return (scope) => -Number(operand(scope)); }
        return parsePrimary();
      }

      function parseMul() {
        let left = parseUnary();
        for (;;) {
          if (eat('*')) { const right = parseUnary(); const previous = left; left = (scope) => Number(previous(scope)) * Number(right(scope)); }
          else if (eat('/')) { const right = parseUnary(); const previous = left; left = (scope) => Number(previous(scope)) / Number(right(scope)); }
          else if (eat('%')) { const right = parseUnary(); const previous = left; left = (scope) => Number(previous(scope)) % Number(right(scope)); }
          else return left;
        }
      }

      function parseAdd() {
        let left = parseMul();
        for (;;) {
          if (eat('+')) {
            const right = parseMul();
            const previous = left;
            left = (scope) => {
              const a = previous(scope);
              const b = right(scope);
              return typeof a === 'string' || typeof b === 'string' ? `${a ?? ''}${b ?? ''}` : Number(a) + Number(b);
            };
          } else if (eat('-')) { const right = parseMul(); const previous = left; left = (scope) => Number(previous(scope)) - Number(right(scope)); }
          else return left;
        }
      }

      function parseComparison() {
        const left = parseAdd();
        const token = peek();
        if (token !== undefined && token.type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(token.value)) {
          position += 1;
          const right = parseAdd();
          const operator = token.value;
          return (scope) => {
            const a = left(scope);
            const b = right(scope);
            switch (operator) {
              case '==': return a === b || String(a) === String(b);
              case '!=': return !(a === b || String(a) === String(b));
              case '<': return Number(a) < Number(b);
              case '<=': return Number(a) <= Number(b);
              case '>': return Number(a) > Number(b);
              default: return Number(a) >= Number(b);
            }
          };
        }
        if (token !== undefined && token.type === 'ident' && token.value === 'in') {
          position += 1;
          const right = parseAdd();
          return (scope) => {
            const a = left(scope);
            const b = right(scope);
            if (typeof b === 'string') return b.includes(String(a));
            if (Array.isArray(b)) return b.some((item) => item === a || String(item) === String(a));
            if (b && typeof b === 'object') return Object.values(b).some((item) => item === a || String(item) === String(a));
            return false;
          };
        }
        return left;
      }

      function parseAnd() {
        let left = parseComparison();
        while (eat('&&')) {
          const right = parseComparison();
          const previous = left;
          left = (scope) => { const a = previous(scope); return truthy(a) ? right(scope) : a; };
        }
        return left;
      }

      function parseOr() {
        let left = parseAnd();
        while (eat('||')) {
          const right = parseAnd();
          const previous = left;
          left = (scope) => { const a = previous(scope); return truthy(a) ? a : right(scope); };
        }
        return left;
      }

      const compiled = parseOr();
      if (position !== tokens.length) throw new Error(`unexpected trailing input in ${JSON.stringify(source)}`);
      return compiled;
    }

    const expressionCache = new Map();

    function evaluate(source, scope) {
      let compiled = expressionCache.get(source);
      if (compiled === undefined) {
        compiled = compileExpression(source);
        expressionCache.set(source, compiled);
      }
      try { return compiled(scope); } catch { return undefined; }
    }

    /* ------------------------------------------------------------------ */
    /* helpers                                                             */
    /* ------------------------------------------------------------------ */

    function truthy(value) { return Boolean(value); }
    function isBlank(value) {
      if (value === undefined || value === null) return true;
      if (typeof value === 'string') return value.trim() === '';
      if (Array.isArray(value)) return value.length === 0;
      if (typeof value === 'object') return Object.keys(value).length === 0;
      return false;
    }
    function valueKey(value) { return JSON.stringify(value === undefined ? null : value); }
    function cls(...names) { return names.filter(Boolean).join(' '); }
    function ticksOf(field) {
      const min = field.min ?? 1;
      const max = field.max ?? 5;
      const step = field.step ?? 1;
      const ticks = [];
      for (let value = min; value <= max + step / 1e6 && ticks.length <= 200; value += step) ticks.push(Number(value.toFixed(6)));
      return ticks;
    }
    function parseRecommended(label) {
      const match = /^\s*(.*?)\s*[（(]\s*(?:recommended|推荐)\s*[)）]\s*$/i.exec(label);
      return match === null ? { label, recommended: false } : { label: match[1], recommended: true };
    }

    /* ------------------------------------------------------------------ */
    /* draft cache (survives a remount of the same pending carrier)         */
    /* ------------------------------------------------------------------ */

    const drafts = new Map();
    function restoreDraft(key) {
      const entry = drafts.get(key);
      if (entry === undefined) return null;
      drafts.delete(key);
      drafts.set(key, entry);
      return entry;
    }
    function saveDraft(key, entry) {
      drafts.delete(key);
      drafts.set(key, entry);
      while (drafts.size > DRAFT_LIMIT) drafts.delete(drafts.keys().next().value);
    }

    /* ------------------------------------------------------------------ */
    /* validation (client-side preview; the Host is authoritative)          */
    /* ------------------------------------------------------------------ */

    /** Option fields accept a free-text addition unless the caller said otherwise. */
    function allowsOther(field) {
      if (field.allowOther === false) return false;
      if (field.allowOther === true) return true;
      return field.type === 'single' || field.type === 'multi' || (field.type === 'tags' && field.options !== undefined);
    }

    function isVisible(field, values) {
      if (field.visibleIf === undefined) return true;
      return truthy(evaluate(field.visibleIf, values));
    }
    function visibleFields(spec, values) {
      return spec.fields.filter((field) => isVisible(field, values));
    }

    function validateField(field, value, values) {
      if (isBlank(value)) return field.required ? field.requiredMessage ?? '此项为必填' : null;
      switch (field.type) {
        case 'confirm':
          return typeof value === 'boolean' ? null : '需要一个是/否答案';
        case 'number':
        case 'integer':
        case 'scale':
        case 'slider': {
          const number = Number(value);
          if (!Number.isFinite(number)) return '需要一个数字';
          if (field.type === 'integer' && !Number.isInteger(number)) return '需要一个整数';
          if (field.min !== undefined && number < field.min) return `不能小于 ${field.min}`;
          if (field.max !== undefined && number > field.max) return `不能大于 ${field.max}`;
          return null;
        }
        case 'single':
        case 'ranking': {
          const list = Array.isArray(value) ? value : [value];
          const allowed = new Set((field.options ?? []).map((option) => valueKey(option.value)));
          if (field.type === 'single' && !allowsOther(field)) {
            const unknown = list.find((item) => !allowed.has(valueKey(item)));
            if (unknown !== undefined) return `不在候选项中：${String(unknown)}`;
          }
          if (field.type === 'ranking' && field.required && list.length !== (field.options ?? []).length) {
            return `请为全部 ${(field.options ?? []).length} 个候选项排序`;
          }
          return null;
        }
        case 'multi': {
          if (allowsOther(field)) return null;
          const list = Array.isArray(value) ? value : [value];
          const allowed = new Set((field.options ?? []).map((option) => valueKey(option.value)));
          const unknown = list.find((item) => !allowed.has(valueKey(item)));
          return unknown === undefined ? null : `不在候选项中：${String(unknown)}`;
        }
        case 'matrix': {
          const missing = (field.rows ?? []).find((row) => isBlank(value[row]));
          return missing === undefined ? null : `请为每一行选择：缺少「${missing}」`;
        }
        case 'budget': {
          const entries = (field.options ?? []).map((option) => ({ option, number: Number(value[option.label]) }));
          const bad = entries.find((entry) => !Number.isFinite(entry.number) || entry.number < 0);
          if (bad !== undefined) return `「${bad.option.label}」需要一个不小于 0 的数字`;
          const total = entries.reduce((sum, entry) => sum + entry.number, 0);
          const target = field.sumTo ?? 100;
          if (Math.abs(total - target) > 1e-6) return `合计必须等于 ${target}（当前 ${total}）`;
          return null;
        }
        case 'tags': {
          const list = Array.isArray(value) ? value : [value];
          if (field.maxLength !== undefined && list.some((item) => String(item).length > field.maxLength)) return `单项长度不能超过 ${field.maxLength}`;
          if (field.pattern !== undefined && list.some((item) => !new RegExp(field.pattern).test(String(item)))) return `不符合格式要求 ${field.pattern}`;
          return null;
        }
        default: {
          const text = String(value);
          if (field.maxLength !== undefined && text.length > field.maxLength) return `长度不能超过 ${field.maxLength}`;
          if (field.pattern !== undefined && !new RegExp(field.pattern).test(text)) return `不符合格式要求 ${field.pattern}`;
          if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return '日期需要 YYYY-MM-DD 格式';
          return null;
        }
      }
    }

    function validateAll(spec, values) {
      const failures = [];
      for (const field of visibleFields(spec, values)) {
        const value = values[field.name];
        const message = validateField(field, value, values);
        if (message !== null) { failures.push({ name: field.name, message }); continue; }
        if (field.validate !== undefined && !isBlank(value) && !truthy(evaluate(field.validate, { ...values, value }))) {
          failures.push({ name: field.name, message: field.validateMessage ?? '未通过自定义校验' });
        }
      }
      return failures;
    }

    /* ------------------------------------------------------------------ */
    /* atoms                                                               */
    /* ------------------------------------------------------------------ */

    const ICONS = {
      check: 'M2.5 7.5l3 3 6-6',
      close: 'M3 3l8 8M11 3l-8 8',
      up: 'M3 9l4-4 4 4',
      down: 'M3 5l4 4-4 4',
      left: 'M9 3L5 7l4 4',
      right: 'M5 3l4 4-4 4',
      dot: 'M7 3.6a3.4 3.4 0 100 6.8 3.4 3.4 0 000-6.8z',
    };

    function Icon({ name, size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 14 14', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false,
      }, h('path', { d: ICONS[name] ?? ICONS.dot }));
    }

    /** Native Button primitive geometry (md, primary/outline/ghost). */
    function Button({ variant = 'outline', className, children, ...rest }) {
      const suffix = variant === 'primary' ? 'Primary' : variant === 'ghost' ? 'Ghost' : 'Outline';
      return h('button', { type: 'button', ...rest, className: cls('daf-button', `daf-button${suffix}`, className) }, children);
    }

    /** Native iconButton: 24px round, tertiary label, hover surface. */
    function IconButton({ label, disabled, onClick, name, size = 14 }) {
      return h('button', {
        type: 'button', className: 'daf-iconButton', 'aria-label': label, title: label, disabled, onClick,
      }, h(Icon, { name, size }));
    }

    /**
     * Render the floating layer into `document.body`, the way the native modal does.
     * Outside a browser (offline tests) it degrades to an in-place layer.
     */
    function Layer({ children }) {
      const layer = h('div', { className: 'daf-frame' },
        h('style', { key: 'daf-stylesheet' }, CSS),
        h('div', { className: 'daf-mask', key: 'daf-mask', 'aria-hidden': true }),
        children);
      if (typeof document === 'undefined' || document.body === undefined || ReactDOM === null || typeof ReactDOM.createPortal !== 'function') return layer;
      return ReactDOM.createPortal(layer, document.body);
    }

    function FieldShell({ field, message, children }) {
      return h('div', { className: 'daf-field' },
        h('div', { className: 'daf-label' },
          field.label,
          field.required ? h('span', { className: 'daf-req', 'aria-hidden': true }, '*') : null),
        children,
        field.help !== undefined ? h('div', { className: 'daf-help' }, field.help) : null,
        field.type === 'ranking' && message === undefined
          ? h('div', { className: 'daf-help' }, '按优先级从高到低排列；用上下箭头调整顺序。')
          : null,
        message !== undefined ? h('div', { className: 'daf-error', role: 'alert' }, message) : null);
    }

    function optionCopy(option) {
      const display = parseRecommended(option.label);
      return [
        h('span', { className: 'daf-optionLine', key: 'line' },
          h('span', { className: 'daf-optionLabel' }, display.label),
          display.recommended ? h('span', { className: 'daf-badge' }, '推荐') : null),
        option.description !== undefined ? h('div', { className: 'daf-description', key: 'desc' }, option.description) : null,
      ];
    }

    /** Native question-composer option row: numbered box when single, checkbox when multi. */
    function OptionRow({ index, selected, multi, disabled, onClick, children }) {
      return h('button', {
        type: 'button',
        role: multi === true ? 'checkbox' : 'radio',
        'aria-checked': selected,
        disabled,
        className: cls('daf-option', selected && 'daf-optionSelected'),
        onClick,
      },
        multi === true
          ? h('span', { className: cls('daf-checkbox', selected && 'daf-checkboxChecked'), 'aria-hidden': true },
            selected ? h(Icon, { name: 'check', size: 12 }) : null)
          : h('span', { className: 'daf-number', 'aria-hidden': true }, String((index ?? 0) + 1)),
        h('span', { className: 'daf-optionCopy' }, children));
    }

    /** Native SegmentedControl track + tabs, used for scales and matrix rows. */
    function Segmented({ label, options, value, onChange, disabled, className, cell }) {
      const selectedIndex = options.findIndex((option) => valueKey(option.value) === valueKey(value));
      return h('div', {
        className: cls('daf-segmentedTrack', className),
        role: 'radiogroup',
        'aria-label': label,
        style: { '--dsh-segment-count': String(Math.max(1, options.length)), '--dsh-segment-index': String(Math.max(0, selectedIndex)) },
      }, options.map((option) => {
        const on = valueKey(option.value) === valueKey(value);
        return h('button', {
          key: valueKey(option.value),
          type: 'button',
          role: 'radio',
          'aria-checked': on,
          disabled,
          className: cls('daf-segment', cell === true ? 'daf-cell' : null, on && 'daf-segmentOn'),
          onClick: () => onChange(option.value),
        }, option.label);
      }));
    }

    /* ------------------------------------------------------------------ */
    /* controls                                                            */
    /* ------------------------------------------------------------------ */

    function ConfirmControl({ field, value, onChange, disabled }) {
      return h('div', { className: 'daf-options', role: 'radiogroup', 'aria-label': field.label },
        field.options.map((option, index) => h(OptionRow, {
          key: valueKey(option.value),
          index,
          selected: valueKey(value) === valueKey(option.value),
          disabled,
          onClick: () => onChange(option.value),
        }, optionCopy(option))));
    }

    function ChoiceControl({ field, value, onChange, disabled }) {
      const multi = field.type === 'multi' || field.type === 'tags';
      const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
      const [other, setOther] = React.useState('');
      const has = (candidate) => list.some((item) => valueKey(item) === valueKey(candidate));
      const toggle = (optionValue) => {
        if (!multi) { onChange(optionValue); return; }
        onChange(has(optionValue) ? list.filter((item) => valueKey(item) !== valueKey(optionValue)) : [...list, optionValue]);
      };
      const addOther = () => {
        const text = other.trim();
        if (text === '') return;
        onChange([...list, text]);
        setOther('');
      };
      return h('div', { className: 'daf-options', role: multi ? 'group' : 'radiogroup', 'aria-label': field.label },
        field.options.map((option, index) => h(OptionRow, {
          key: valueKey(option.value),
          index,
          multi,
          selected: multi ? has(option.value) : valueKey(value) === valueKey(option.value),
          disabled,
          onClick: () => toggle(option.value),
        }, optionCopy(option))),
        allowsOther(field)
          ? h('div', { className: 'daf-option', key: '__other__' },
            multi
              ? h('span', { className: 'daf-checkbox', 'aria-hidden': true }, null)
              : h('span', { className: 'daf-number', 'aria-hidden': true }, '·'),
            h('span', { className: 'daf-optionCopy' },
              h('input', {
                className: 'daf-input',
                value: other,
                disabled,
                placeholder: multi ? '其他（回车添加）' : '其他答案（回车选择）',
                onChange: (event) => setOther(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  if (multi) addOther();
                  else if (other.trim() !== '') onChange(other.trim());
                },
              })))
          : null);
    }

    function ScaleControl({ field, value, onChange, disabled }) {
      const ticks = ticksOf(field);
      return h('div', { className: 'daf-sub' },
        h(Segmented, {
          label: field.label,
          options: ticks.map((tick) => ({ value: tick, label: String(tick) })),
          value,
          onChange,
          disabled,
        }),
        field.anchors !== undefined
          ? h('div', { className: 'daf-anchors' }, h('span', null, field.anchors.min ?? ''), h('span', null, field.anchors.max ?? ''))
          : null);
    }

    function SliderControl({ field, value, onChange, disabled }) {
      const min = field.min ?? 0;
      const max = field.max ?? 100;
      const step = field.step ?? 1;
      const numeric = Number(value);
      const current = Number.isFinite(numeric) ? numeric : Number((Math.round(((min + max) / 2) / step) * step).toFixed(6));
      return h('div', { className: 'daf-sub' },
        h('div', { className: 'daf-inputWrap' },
          h('input', {
            className: 'daf-range', type: 'range', min, max, step, value: current, disabled,
            'aria-label': field.label,
            onChange: (event) => onChange(Number(event.target.value)),
          }),
          h('span', { className: 'daf-tag' }, `${current}${field.unit === undefined ? '' : ` ${field.unit}`}`)),
        field.anchors !== undefined
          ? h('div', { className: 'daf-anchors' }, h('span', null, field.anchors.min ?? ''), h('span', null, field.anchors.max ?? ''))
          : null);
    }

    function NumberControl({ field, value, onChange, disabled, invalid }) {
      return h('div', { className: cls('daf-inputWrap', invalid && 'daf-invalid') },
        h('input', {
          className: 'daf-input',
          type: 'number',
          inputMode: 'decimal',
          min: field.min,
          max: field.max,
          step: field.type === 'integer' ? 1 : field.step,
          value: value === undefined || value === null ? '' : String(value),
          placeholder: field.placeholder ?? '',
          disabled,
          'aria-label': field.label,
          onChange: (event) => onChange(event.target.value === '' ? undefined : Number(event.target.value)),
        }),
        field.unit !== undefined ? h('span', { className: 'daf-tag' }, field.unit) : null);
    }

    function TextControl({ field, value, onChange, disabled, invalid, multiline, inputType }) {
      const shared = {
        className: multiline === true ? 'daf-textarea' : 'daf-input',
        value: value === undefined || value === null ? '' : String(value),
        placeholder: field.placeholder ?? '',
        disabled,
        'aria-label': field.label,
        onChange: (event) => onChange(event.target.value === '' ? undefined : event.target.value),
      };
      if (multiline === true) {
        return h('div', { className: cls('daf-textareaBlock', invalid && 'daf-invalid') }, h('textarea', { ...shared, rows: 3 }));
      }
      return h('div', { className: cls('daf-inputWrap', invalid && 'daf-invalid') }, h('input', { ...shared, type: inputType ?? 'text' }));
    }

    function TagsControl({ field, value, onChange, disabled }) {
      const list = Array.isArray(value) ? value : [];
      const [draft, setDraft] = React.useState('');
      const commit = () => {
        const text = draft.trim();
        if (text === '') return;
        if (!list.some((item) => String(item) === text)) onChange([...list, text]);
        setDraft('');
      };
      return h('div', { className: 'daf-tagBox' },
        list.map((item, index) => h('span', { className: 'daf-tag', key: `${String(item)}-${index}` },
          String(item),
          h('button', {
            type: 'button', className: 'daf-tagX', disabled,
            'aria-label': `移除 ${String(item)}`,
            onClick: () => onChange(list.filter((_, position) => position !== index)),
          }, h(Icon, { name: 'close', size: 9 })))),
        h('input', {
          className: 'daf-tagInput',
          value: draft,
          disabled,
          placeholder: field.placeholder ?? '输入后回车添加',
          'aria-label': field.label,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Backspace' && draft === '' && list.length > 0) {
              onChange(list.slice(0, -1));
            }
          },
          onBlur: commit,
        }));
    }

    function RankingControl({ field, value, onChange, disabled }) {
      const options = field.options ?? [];
      const order = Array.isArray(value) && value.length === options.length ? value : options.map((option) => option.value);
      const labelOf = (candidate) => options.find((option) => valueKey(option.value) === valueKey(candidate))?.label ?? String(candidate);
      const move = (index, delta) => {
        const target = index + delta;
        if (target < 0 || target >= order.length) return;
        const next = [...order];
        [next[index], next[target]] = [next[target], next[index]];
        onChange(next);
      };
      return h('div', { className: 'daf-rank' },
        order.map((item, index) => h('div', { className: 'daf-rankRow', key: valueKey(item) },
          h('span', { className: 'daf-rankIndex' }, String(index + 1)),
          h('span', { className: 'daf-rankLabel' }, labelOf(item)),
          h(IconButton, {
            label: `把「${labelOf(item)}」上移`,
            name: 'up',
            size: 12,
            disabled: disabled || index === 0,
            onClick: () => move(index, -1),
          }),
          h(IconButton, {
            label: `把「${labelOf(item)}」下移`,
            name: 'down',
            size: 12,
            disabled: disabled || index === order.length - 1,
            onClick: () => move(index, 1),
          }))));
    }

    function MatrixControl({ field, value, onChange, disabled }) {
      const rows = field.rows ?? [];
      const options = field.options ?? [];
      const record = value !== null && typeof value === 'object' ? value : {};
      return h('div', { className: 'daf-matrix' },
        rows.map((row) => h('div', { className: 'daf-matrixRow', key: row },
          h('span', { className: 'daf-matrixLabel', title: row }, row),
          h(Segmented, {
            label: `${field.label}：${row}`,
            options: options.map((option) => ({ value: option.value, label: parseRecommended(option.label).label })),
            value: record[row],
            onChange: (next) => onChange({ ...record, [row]: next }),
            disabled,
            cell: true,
          }))));
    }

    function BudgetControl({ field, value, onChange, disabled }) {
      const options = field.options ?? [];
      const record = value !== null && typeof value === 'object' ? value : {};
      const target = field.sumTo ?? 100;
      const numbers = options.map((option) => Number(record[option.label]));
      const total = numbers.reduce((sum, number) => sum + (Number.isFinite(number) ? number : 0), 0);
      return h('div', { className: 'daf-budget' },
        options.map((option, index) => h('div', { className: 'daf-budgetRow', key: option.label },
          h('span', { className: 'daf-budgetName', title: option.label }, option.label),
          h('div', { className: 'daf-inputWrap daf-budgetInput' },
            h('input', {
              className: 'daf-input',
              type: 'number',
              min: 0,
              max: target,
              step: 1,
              disabled,
              value: Number.isFinite(numbers[index]) ? String(numbers[index]) : '',
              'aria-label': `${option.label} 的数值`,
              onChange: (event) => onChange({ ...record, [option.label]: event.target.value === '' ? undefined : Number(event.target.value) }),
            })),
          h('div', { className: 'daf-bar' },
            h('div', {
              className: 'daf-barFill',
              style: { width: `${Math.max(0, Math.min(100, ((Number.isFinite(numbers[index]) ? numbers[index] : 0) / target) * 100))}%` },
            })))),
        h('div', { className: cls('daf-total', total !== target && 'daf-error') }, `合计 ${total} / ${target}`),
        h('button', {
          type: 'button', className: 'daf-linkBtn', disabled,
          onClick: () => onChange(Object.fromEntries(options.map((option) => [option.label, target / options.length]))),
        }, '平均分配'));
    }


    function FieldControl({ field, value, onChange, disabled, invalid }) {
      const shared = { field, value, onChange, disabled, invalid };
      switch (field.type) {
        case 'confirm': return h(ConfirmControl, shared);
        case 'single': return h(ChoiceControl, shared);
        case 'multi': return h(ChoiceControl, shared);
        case 'tags': return field.options === undefined ? h(TagsControl, shared) : h(ChoiceControl, shared);
        case 'scale': return h(ScaleControl, shared);
        case 'slider': return h(SliderControl, shared);
        case 'ranking': return h(RankingControl, shared);
        case 'matrix': return h(MatrixControl, shared);
        case 'budget': return h(BudgetControl, shared);
        case 'number':
        case 'integer': return h(NumberControl, shared);
        case 'longtext': return h(TextControl, { ...shared, multiline: true });
        case 'date': return h(TextControl, { ...shared, inputType: 'date' });
        default: return h(TextControl, shared);
      }
    }

    function FieldBlock({ field, value, onChange, disabled, message }) {
      return h(FieldShell, { field, message },
        h(FieldControl, { field, value, onChange, disabled, invalid: message !== undefined }));
    }

    /* ------------------------------------------------------------------ */
    /* the form card                                                       */
    /* ------------------------------------------------------------------ */

    function initialValues(spec) {
      return spec.initial !== null && typeof spec.initial === 'object' ? { ...spec.initial } : {};
    }

    function FormCard({ carrier, spec }) {
      const restored = restoreDraft(carrier.key);
      const [values, setValues] = React.useState(() => (restored === null ? initialValues(spec) : restored.values));
      const [notes, setNotes] = React.useState(() => (restored === null ? '' : restored.notes ?? ''));
      const [errors, setErrors] = React.useState(() => Object.fromEntries((spec.errors ?? []).map((error) => [error.name, error.message])));
      const [busy, setBusy] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [index, setIndex] = React.useState(0);
      const visible = visibleFields(spec, values);
      const steps = spec.layout === 'steps';
      const current = visible.length === 0 ? undefined : visible[Math.min(index, visible.length - 1)];
      const cardRef = React.useRef(null);
      const probed = React.useRef(false);

      /**
       * Diagnostic path: with the magic title the card reports where it landed and which element
       * sits on top of it, then answers at once — no user interaction and no screenshot needed.
       */
      React.useEffect(() => {
        if (spec.title !== PROBE_TITLE || probed.current) return undefined;
        probed.current = true;
        const timer = setTimeout(() => {
          const name = (node) => {
            if (node === null || node === undefined) return null;
            const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '?';
            const cls = typeof node.className === 'string' && node.className !== '' ? `.${node.className.split(/\s+/).slice(0, 3).join('.')}` : '';
            return `${tag}${cls}`;
          };
          const chain = (node) => {
            const out = [];
            let cursor = node;
            for (let depth = 0; depth < 5 && cursor !== null && cursor !== undefined; depth += 1) {
              out.push(name(cursor));
              cursor = cursor.parentElement;
            }
            return out;
          };
          const rect = (node) => {
            if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return null;
            const box = node.getBoundingClientRect();
            return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
          };
          const card = cardRef.current;
          const option = card === null ? null : card.querySelector('.daf-option');
          const primary = card === null ? null : card.querySelector('.daf-buttonPrimary');
          const at = (node) => {
            if (node === null || typeof node.getBoundingClientRect !== 'function') return null;
            const box = node.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) return null;
            return chain(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          };
          const input = card === null ? null : card.querySelector('input, textarea');
          /** Does a click at this node's centre actually land inside this node? */
          const hit = (node) => {
            if (node === null || typeof node.getBoundingClientRect !== 'function') return null;
            const box = node.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) return 'zero-size';
            const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            if (target === null) return 'outside-viewport';
            return { landedOn: name(target), insideSelf: node.contains(target) };
          };
          const styleOf = (node) => {
            if (node === null || typeof node.getBoundingClientRect !== 'function') return null;
            const computed = getComputedStyle(node);
            return { position: computed.position, width: computed.width, zIndex: computed.zIndex, pointerEvents: computed.pointerEvents };
          };
          const report = {
            client: CLIENT_VERSION,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            card: rect(card),
            input: rect(input),
            primary: rect(primary),
            option: rect(option),
            cardStyle: styleOf(card),
            frameStyle: styleOf(card === null ? null : card.parentElement),
            styleTags: document.querySelectorAll('style').length,
            hitCard: hit(card),
            hitInput: hit(input),
            hitPrimary: hit(primary),
            atCardCenter: at(card),
            atOptionCenter: at(option),
            atPrimaryCenter: at(primary),
            seatCount: document.querySelectorAll('[data-composer-seat]').length,
            lastBodyChild: name(document.body.lastElementChild),
          };
          Promise.resolve(carrier.answer({
            answers: [{
              id: spec.markerId ?? 'dsh-form:__probe__',
              selected: [],
              custom: `${ENVELOPE_PREFIX}${JSON.stringify({ values: {}, notes: JSON.stringify(report) })}`,
            }],
          })).catch(() => {});
        }, 150);
        return () => clearTimeout(timer);
      }, [carrier, spec.title, spec.markerId]);

      React.useEffect(() => { saveDraft(carrier.key, { values, notes }); }, [carrier.key, values, notes]);

      /** Re-enable the card when the answer never reaches the Host (a frozen or replaced connection). */
      const watchdog = React.useRef(null);
      const clearWatchdog = () => {
        if (watchdog.current !== null) {
          clearTimeout(watchdog.current);
          watchdog.current = null;
        }
      };
      React.useEffect(() => clearWatchdog, []);
      /** A page restored from the back-forward cache lost the socket that carried this request. */
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onPageShow = (event) => {
          if (event.persisted === true) {
            setFailure('页面是从后退/前进缓存恢复的：这次提问的连接已经断开，答案传不回去。请刷新页面，然后让模型重新提问。');
          }
        };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
      }, []);
      const armWatchdog = () => {
        clearWatchdog();
        watchdog.current = setTimeout(() => {
          watchdog.current = null;
          setBusy(null);
          setFailure('提交没有响应：连接可能已断开（页面被冻结或恢复过）。请重试，或刷新页面后重新提问。');
        }, 10000);
      };

      const setValue = (name, next) => {
        setValues((previous) => ({ ...previous, [name]: next }));
        setErrors((previous) => {
          if (previous[name] === undefined) return previous;
          const copy = { ...previous };
          delete copy[name];
          return copy;
        });
        setFailure(null);
      };

      const cancel = () => {
        if (busy !== null) return;
        setBusy('cancel');
        setFailure(null);
        armWatchdog();
        Promise.resolve(carrier.cancel()).then(clearWatchdog).catch((cause) => {
          clearWatchdog();
          setBusy(null);
          setFailure(cause instanceof Error ? cause.message : String(cause));
        });
      };

      const submit = () => {
        if (busy !== null) return;
        const failures = validateAll(spec, values);
        if (failures.length > 0) {
          setErrors(Object.fromEntries(failures.map((entry) => [entry.name, entry.message])));
          setFailure(`还有 ${failures.length} 项需要修正`);
          if (steps) {
            const target = visible.findIndex((field) => field.name === failures[0].name);
            if (target >= 0) setIndex(target);
          }
          return;
        }
        const payload = {};
        for (const field of visibleFields(spec, values)) {
          if (values[field.name] !== undefined) payload[field.name] = values[field.name];
        }
        const trimmed = notes.trim();
        setBusy('submit');
        setFailure(null);
        armWatchdog();
        Promise.resolve(carrier.answer({
          answers: [{
            id: spec.markerId ?? 'dsh-form:__form__',
            selected: [],
            custom: `${ENVELOPE_PREFIX}${JSON.stringify({ values: payload, ...(trimmed === '' ? {} : { notes: trimmed }) })}`,
          }],
        }))
          .then(() => { clearWatchdog(); drafts.delete(carrier.key); })
          .catch((cause) => {
            clearWatchdog();
            setBusy(null);
            setFailure(cause instanceof Error ? cause.message : String(cause));
          });
      };

      const rendered = [];
      const shown = steps ? (current === undefined ? [] : [current]) : visible;
      for (const field of shown) {
        rendered.push(h(FieldBlock, {
          key: field.name,
          field,
          value: values[field.name],
          message: errors[field.name],
          disabled: busy !== null,
          onChange: (next) => setValue(field.name, next),
        }));
      }
      if (!steps && spec.notes !== null && spec.notes !== undefined) {
        rendered.push(h('div', { className: 'daf-field', key: '__notes__' },
          h('div', { className: 'daf-label' }, spec.notes.label ?? '补充说明'),
          h('div', { className: 'daf-textareaBlock' },
            h('textarea', {
              className: 'daf-textarea',
              rows: 2,
              value: notes,
              disabled: busy !== null,
              placeholder: spec.notes.placeholder ?? '',
              'aria-label': spec.notes.label ?? '补充说明',
              onChange: (event) => setNotes(event.target.value),
            }))));
      }

      return h(Layer, null,
        h('section', {
          ref: cardRef,
          className: 'daf-card',
          role: 'dialog',
          'aria-label': spec.title ?? '结构化表单',
        },
          h('header', { className: 'daf-header' },
            h('div', { className: 'daf-headingBlock' },
              h('div', { className: 'daf-eyebrow' }, `结构化表单 · ${CLIENT_VERSION}`),
              h('h2', { className: 'daf-title' }, spec.title ?? '请填写表单'),
              spec.intro !== undefined && spec.intro !== '' ? h('p', { className: 'daf-detail' }, spec.intro) : null),
            h('div', { className: 'daf-headerActions' },
              h('button', {
                type: 'button',
                className: 'daf-close',
                'aria-label': '放弃整组问题',
                title: '放弃整组问题',
                disabled: busy !== null,
                onClick: cancel,
              }, h(Icon, { name: 'close', size: 14 })))),
          h('div', { className: 'daf-body' }, h('div', { className: 'daf-fields' }, rendered)),
          h('footer', { className: 'daf-footer' },
            steps
              ? h('div', { className: 'daf-pager' },
                h(IconButton, {
                  label: '上一题',
                  name: 'left',
                  size: 12,
                  disabled: busy !== null || index === 0,
                  onClick: () => setIndex((previous) => Math.max(0, previous - 1)),
                }),
                h('span', { className: 'daf-progress' }, `${Math.min(index, Math.max(0, visible.length - 1)) + 1} / ${visible.length}`),
                h(IconButton, {
                  label: '下一题',
                  name: 'right',
                  size: 12,
                  disabled: busy !== null || index >= visible.length - 1,
                  onClick: () => setIndex((previous) => Math.min(visible.length - 1, previous + 1)),
                }))
              : null,
            h('div', { className: 'daf-feedback', role: 'status' }, failure ?? ''),
            h('div', { className: 'daf-footerActions' },
              h(Button, { variant: 'outline', disabled: busy !== null, onClick: cancel }, '取消'),
              h(Button, { variant: 'primary', disabled: busy !== null, onClick: submit }, busy === 'submit' ? '提交中…' : spec.submitLabel ?? '提交')))));
    }

    /* ------------------------------------------------------------------ */
    /* the script escape hatch                                             */
    /* ------------------------------------------------------------------ */

    function ScriptCard({ carrier, spec }) {
      const [values, setValues] = React.useState(() => initialValues(spec));
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const built = React.useMemo(() => {
        try {
          const source = spec.script === null || spec.script === undefined ? '' : String(spec.script.source);
          return { build: new Function('React', 'h', 'props', `"use strict";return (${source})(props);`) };
        } catch (error) {
          return { error };
        }
      }, [spec.script]);

      const submit = (next) => {
        if (busy) return;
        const payload = next !== null && typeof next === 'object' ? next : values;
        setBusy(true);
        setFailure(null);
        Promise.resolve(carrier.answer({
          answers: [{
            id: spec.markerId ?? 'dsh-form:__script__',
            selected: [],
            custom: `${ENVELOPE_PREFIX}${JSON.stringify({ values: payload })}`,
          }],
        }))
          .then(() => { drafts.delete(carrier.key); })
          .catch((cause) => {
            setBusy(false);
            setFailure(cause instanceof Error ? cause.message : String(cause));
          });
      };

      if (built.error) return h(ErrorCard, { carrier, error: built.error });

      const setValues_ = (next) => setValues(typeof next === 'function' ? next(values) : next);
      const props = {
        React,
        h,
        spec,
        values,
        busy,
        failure,
        setValue: (name, next) => setValues((previous) => ({ ...previous, [name]: next })),
        setValues: setValues_,
        submit,
        cancel: () => Promise.resolve(carrier.cancel()),
        t: (key) => key,
      };

      let element;
      try {
        element = built.build(React, h, props);
      } catch (error) {
        return h(ErrorCard, { carrier, error });
      }
      if (element === undefined || element === null) return h(ErrorCard, { carrier, error: new Error('script returned no element') });

      return h('div', { className: 'daf-frame' },
        h('section', { className: 'daf-card' },
          h('header', { className: 'daf-header' },
            h('div', { className: 'daf-headingBlock' },
              h('div', { className: 'daf-eyebrow' }, `自定义交互 · ${CLIENT_VERSION}`),
              h('h2', { className: 'daf-title' }, spec.title ?? '请完成这个交互')),
            h('div', null,
              h('button', {
                type: 'button', className: 'daf-iconButton', 'aria-label': '取消', disabled: busy,
                onClick: () => { Promise.resolve(carrier.cancel()); },
              }, h(Icon, { name: 'close', size: 13 })))),
          h('div', { className: 'daf-body' }, element),
          h('footer', { className: 'daf-footer' },
            h('div', { className: 'daf-feedback', role: 'status' }, failure ?? ''),
            h('div', { className: 'daf-footerActions' },
              h(Button, {
                variant: 'ghost', disabled: busy,
                onClick: () => { Promise.resolve(carrier.cancel()); },
              }, '取消'),
              h(Button, { variant: 'primary', disabled: busy, onClick: () => submit(values) }, busy ? '提交中…' : '提交')))));
    }

    /* ------------------------------------------------------------------ */
    /* error surface                                                       */
    /* ------------------------------------------------------------------ */

    function ErrorCard({ carrier, error }) {
      const [busy, setBusy] = React.useState(false);
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const details = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
      const report = () => {
        setBusy(true);
        Promise.resolve(carrier.answer({
          answers: [{
            id: 'dsh-form:__error__',
            selected: [],
            custom: `${ENVELOPE_PREFIX}${JSON.stringify({ values: {}, scriptError: message })}`,
          }],
        })).catch(() => setBusy(false));
      };
      return h('div', { className: 'daf-frame' },
        h('section', { className: 'daf-card' },
          h('header', { className: 'daf-header' },
            h('div', { className: 'daf-headingBlock' },
              h('div', { className: 'daf-eyebrow' }, `表单渲染失败 · ${CLIENT_VERSION}`),
              h('h2', { className: 'daf-title' }, '这个交互没能渲染'))),
          h('div', { className: 'daf-body' }, h('div', { className: 'daf-fields' },
            h('div', { className: 'daf-error' }, message),
            details === '' ? null : h('pre', { className: 'daf-stack' }, details),
            h('div', { className: 'daf-help' }, '把错误交回模型，模型就能换一种方式重新提问。'))),
          h('footer', { className: 'daf-footer' },
            h('div', { className: 'daf-feedback' }),
            h('div', { className: 'daf-footerActions' },
              h(Button, { variant: 'ghost', disabled: busy, onClick: () => { Promise.resolve(carrier.cancel()); } }, '取消'),
              h(Button, { variant: 'primary', disabled: busy, onClick: report }, '把错误交回模型')))));
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        if (typeof console !== 'undefined') console.error('[ask-form] form surface crashed', error);
      }
      render() {
        if (this.state.error !== null) return h(ErrorCard, { carrier: this.props.carrier, error: this.state.error });
        return this.props.children;
      }
    }

    /* ------------------------------------------------------------------ */
    /* slot entry                                                          */
    /* ------------------------------------------------------------------ */

    function specOf(carrier) {
      const questions = carrier !== null && carrier !== undefined && Array.isArray(carrier.questions) ? carrier.questions : [];
      for (const question of questions) {
        const spec = question !== null && question !== undefined && question.intent !== undefined ? question.intent.spec : undefined;
        if (question !== null && question !== undefined && question.intent !== undefined && question.intent.kind === MARKER_KIND
          && spec !== null && typeof spec === 'object' && Array.isArray(spec.fields)) {
          return spec;
        }
      }
      return null;
    }

    function FormComposer(props) {
      const carrier = props.matched;
      const spec = React.useMemo(() => specOf(carrier), [carrier]);
      if (spec === null) return null;
      const card = spec.mode === 'script'
        ? h(ScriptCard, { carrier, spec, key: carrier.key })
        : h(FormCard, { carrier, spec, key: carrier.key });
      return h(Boundary, { carrier }, card);
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: -100,
        select: ({ pendingInteraction }) => (specOf(pendingInteraction) === null ? null : pendingInteraction),
      }, FormComposer));
    }

    return { inject: ['slots'], apply };
  },
});
