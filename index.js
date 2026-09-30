/**
 * Host half of `@zekilou/dsh-ask-form`.
 *
 * Registers the model-facing `ask_form` tool: a structured-question surface on top of the
 * `ctx.userQuestions` seam. It compiles a typed form spec into ordinary
 * `AskUserQuestionItem[]` (so any answerer can still answer it), carries the rich spec to its
 * own Client renderer through the item's `intent` (invisible to generic renderers), decodes
 * either the renderer's JSON envelope or the generic option/label answers, validates on the
 * Host, and re-asks only the fields that failed.
 *
 * Design notes:
 * - No `@deepseek-ai/*` imports: the tool definition is a plain registry object and the
 *   protocol types are read structurally.
 * - The envelope sentinel is a control character, so user-typed text can never forge it.
 * - Everything the model sees must be reconstructable from the log: the spec travels inside
 *   the logged question request, so replay keeps the same question.
 *
 * @module @zekilou/dsh-ask-form
 */

/** Marker tag carried in `AskUserQuestionItem.intent.kind` for requests this plugin owns. */
const MARKER_KIND = 'dsh-form';
/** Answer-envelope sentinel; `\u0001` cannot appear in user input. */
const ENVELOPE_PREFIX = '\u0001dsh-form:';
/** Envelope schema version, carried so an older reader can refuse a newer payload. */
const SPEC_VERSION = 1;
/** Upper bound on interactive rounds (one initial ask plus re-asks). */
const MAX_ROUNDS_LIMIT = 5;
const DEFAULT_MAX_ROUNDS = 3;
const MAX_FIELDS = 48;
/** Degraded rendering falls back to a plain option list up to this many ticks. */
const MAX_DEGRADED_TICKS = 21;

const CHOICE_TYPES = ['confirm', 'single', 'multi'];
const TEXT_TYPES = ['text', 'longtext', 'number', 'integer', 'date'];
const FIELD_TYPES = [...CHOICE_TYPES, ...TEXT_TYPES, 'scale', 'slider', 'tags', 'ranking', 'matrix', 'budget'];

/* -------------------------------------------------------------------------- */
/* expression evaluator (L2): a whitelisted mini-language, never `eval`        */
/* -------------------------------------------------------------------------- */

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

/**
 * Split an expression into tokens.
 * @param {string} source - expression text.
 * @returns {Array<{type: string, value: unknown}>} tokens.
 */
function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
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
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(pair)) {
      tokens.push({ type: 'op', value: pair });
      index += 2;
      continue;
    }
    if ('+-*/%()!,<>'.includes(char)) {
      tokens.push({ type: 'op', value: char });
      index += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in ${JSON.stringify(source)}`);
  }
  return tokens;
}

/**
 * Compile an expression into `(scope) => value`.
 * Grammar: `|| && == != < <= > >= in + - * / % unary-primary`, with a whitelisted
 * function table and no property access, assignment, or host object reachability.
 * @param {string} source - expression text.
 * @returns {(scope: Record<string, unknown>) => unknown} evaluator.
 */
function compileExpression(source) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const eat = (value) => {
    const token = tokens[position];
    if (token !== undefined && token.type === 'op' && token.value === value) {
      position += 1;
      return true;
    }
    return false;
  };
  const eatWord = (word) => {
    const token = tokens[position];
    if (token !== undefined && token.type === 'ident' && token.value === word) {
      position += 1;
      return true;
    }
    return false;
  };
  const expect = (value) => {
    if (!eat(value)) throw new Error(`expected ${JSON.stringify(value)} in ${JSON.stringify(source)}`);
  };

  function parsePrimary() {
    const token = peek();
    if (token === undefined) throw new Error(`unexpected end of expression ${JSON.stringify(source)}`);
    if (token.type === 'number' || token.type === 'string') {
      position += 1;
      return () => token.value;
    }
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
        if (fn === undefined) {
          throw new Error(`unknown function ${JSON.stringify(token.value)} in ${JSON.stringify(source)}; allowed: ${Object.keys(EXPRESSION_FUNCTIONS).join(', ')}`);
        }
        return (scope) => fn(...args.map((arg) => arg(scope)));
      }
      const name = token.value;
      return (scope) => (scope === null || scope === undefined ? undefined : scope[name]);
    }
    if (eat('(')) {
      const inner = parseOr();
      expect(')');
      return inner;
    }
    throw new Error(`unexpected token ${JSON.stringify(token.value)} in ${JSON.stringify(source)}`);
  }

  function parseUnary() {
    if (eat('!')) {
      const operand = parseUnary();
      return (scope) => !truthy(operand(scope));
    }
    if (eat('-')) {
      const operand = parseUnary();
      return (scope) => -Number(operand(scope));
    }
    return parsePrimary();
  }

  function parseMul() {
    let left = parseUnary();
    for (;;) {
      if (eat('*')) {
        const right = parseUnary();
        const previous = left;
        left = (scope) => Number(previous(scope)) * Number(right(scope));
      } else if (eat('/')) {
        const right = parseUnary();
        const previous = left;
        left = (scope) => Number(previous(scope)) / Number(right(scope));
      } else if (eat('%')) {
        const right = parseUnary();
        const previous = left;
        left = (scope) => Number(previous(scope)) % Number(right(scope));
      } else {
        return left;
      }
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
      } else if (eat('-')) {
        const right = parseMul();
        const previous = left;
        left = (scope) => Number(previous(scope)) - Number(right(scope));
      } else {
        return left;
      }
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
          case '==':
            return a === b || String(a) === String(b);
          case '!=':
            return !(a === b || String(a) === String(b));
          case '<':
            return Number(a) < Number(b);
          case '<=':
            return Number(a) <= Number(b);
          case '>':
            return Number(a) > Number(b);
          default:
            return Number(a) >= Number(b);
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
      left = (scope) => {
        const a = previous(scope);
        return truthy(a) ? right(scope) : a;
      };
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (eat('||')) {
      const right = parseAnd();
      const previous = left;
      left = (scope) => {
        const a = previous(scope);
        return truthy(a) ? a : right(scope);
      };
    }
    return left;
  }

  const compiled = parseOr();
  if (position !== tokens.length) throw new Error(`unexpected trailing input in ${JSON.stringify(source)}`);
  return compiled;
}

/** @type {Map<string, (scope: Record<string, unknown>) => unknown>} */
const expressionCache = new Map();

/**
 * Evaluate an expression against a scope, with a compiled-expression cache.
 * @param {string} source - expression text.
 * @param {Record<string, unknown>} scope - field values plus `value` where applicable.
 * @returns {unknown} the expression result.
 */
function evaluate(source, scope) {
  let compiled = expressionCache.get(source);
  if (compiled === undefined) {
    compiled = compileExpression(source);
    expressionCache.set(source, compiled);
  }
  try {
    return compiled(scope);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* value helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Standard JS truthiness, used by the evaluator's boolean operators. */
function truthy(value) {
  return Boolean(value);
}

/** Whether a value counts as "no answer". */
function isBlank(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** Render any value as display text. */
function asString(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

/** Stable JSON identity for option-value membership tests. */
function valueKey(value) {
  return JSON.stringify(value === undefined ? null : value);
}

/* -------------------------------------------------------------------------- */
/* field and form normalization                                               */
/* -------------------------------------------------------------------------- */

/**
 * Normalize one declared option.
 * @param {unknown} raw - a string label or `{label, description?, value?}`.
 * @param {string} fieldName - owning field, for diagnostics.
 * @returns {{label: string, description?: string, value: unknown}} option.
 */
function normalizeOption(raw, fieldName) {
  if (typeof raw === 'string') return { label: raw, value: raw };
  if (raw !== null && typeof raw === 'object' && typeof raw.label === 'string') {
    return {
      label: raw.label,
      ...raw.description === undefined ? {} : { description: String(raw.description) },
      value: 'value' in raw && raw.value !== undefined ? raw.value : raw.label,
    };
  }
  throw new Error(`ask_form: field "${fieldName}" options must be strings or {label, description?, value?} objects`);
}

/** Inclusive tick list for scale/slider degradation. */
function ticksOf(field) {
  const min = field.min ?? (field.type === 'slider' ? 0 : 1);
  const max = field.max ?? (field.type === 'slider' ? 100 : 5);
  const step = field.step ?? 1;
  const ticks = [];
  for (let value = min; value <= max + step / 1e6 && ticks.length <= 200; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}

/**
 * Validate and normalize one declared field.
 * @param {unknown} raw - the model-authored field object.
 * @param {number} index - declaration index, for diagnostics.
 * @returns {object} normalized field.
 */
function normalizeField(raw, index) {
  if (raw === null || typeof raw !== 'object') throw new Error(`ask_form: field ${index} must be an object`);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '') throw new Error(`ask_form: field ${index} requires a name`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`ask_form: field name ${JSON.stringify(name)} must be an identifier (letters, digits, underscore) so conditions can reference it`);
  }
  const type = raw.type === undefined ? 'single' : String(raw.type);
  if (!FIELD_TYPES.includes(type)) {
    throw new Error(`ask_form: field "${name}" has unknown type ${JSON.stringify(type)}; allowed: ${FIELD_TYPES.join(', ')}`);
  }
  const field = {
    name,
    type,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : name,
    required: raw.required === undefined ? true : Boolean(raw.required),
  };
  if (typeof raw.help === 'string' && raw.help !== '') field.help = raw.help;
  if (typeof raw.placeholder === 'string' && raw.placeholder !== '') field.placeholder = raw.placeholder;
  if (typeof raw.unit === 'string' && raw.unit !== '') field.unit = raw.unit;
  if (typeof raw.pattern === 'string' && raw.pattern !== '') field.pattern = raw.pattern;
  if (typeof raw.max_length === 'number' && Number.isFinite(raw.max_length)) field.maxLength = raw.max_length;
  if (typeof raw.visible_if === 'string' && raw.visible_if.trim() !== '') field.visibleIf = raw.visible_if;
  if (typeof raw.validate === 'string' && raw.validate.trim() !== '') field.validate = raw.validate;
  if (typeof raw.validate_message === 'string' && raw.validate_message !== '') field.validateMessage = raw.validate_message;
  if (typeof raw.required_message === 'string' && raw.required_message !== '') field.requiredMessage = raw.required_message;
  if (raw.allow_other !== undefined) field.allowOther = Boolean(raw.allow_other);
  if (raw.default !== undefined) field.default = raw.default;
  if (raw.anchors !== undefined && raw.anchors !== null && typeof raw.anchors === 'object') {
    field.anchors = {
      ...typeof raw.anchors.min === 'string' ? { min: raw.anchors.min } : {},
      ...typeof raw.anchors.max === 'string' ? { max: raw.anchors.max } : {},
    };
  }
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) throw new Error(`ask_form: field "${name}" options must be an array`);
    field.options = raw.options.map((option) => normalizeOption(option, name));
    const labels = new Set(field.options.map((option) => option.label));
    if (labels.size !== field.options.length) throw new Error(`ask_form: field "${name}" has duplicate option labels; labels must be unique`);
  }
  if (raw.rows !== undefined) {
    if (!Array.isArray(raw.rows) || raw.rows.some((row) => typeof row !== 'string' || row.trim() === '')) {
      throw new Error(`ask_form: field "${name}" rows must be a non-empty array of non-empty strings`);
    }
    field.rows = [...raw.rows];
  }
  for (const key of ['min', 'max', 'step', 'sum_to']) {
    if (raw[key] !== undefined) {
      const value = Number(raw[key]);
      if (!Number.isFinite(value)) throw new Error(`ask_form: field "${name}" ${key} must be a number`);
      if (key === 'sum_to') field.sumTo = value;
      else field[key] = value;
    }
  }

  switch (type) {
    case 'confirm': {
      field.options ??= [
        { label: '是', value: true },
        { label: '否', value: false },
      ];
      if (field.options.length !== 2) throw new Error(`ask_form: confirm field "${name}" needs exactly two options`);
      break;
    }
    case 'single':
    case 'multi':
    case 'ranking': {
      if (field.options === undefined || field.options.length < 2) {
        throw new Error(`ask_form: ${type} field "${name}" needs at least two options`);
      }
      // A closed option list is the exception, not the rule: single/multi offer a free-text
      // addition unless the caller opts out with allow_other: false.
      if ((type === 'single' || type === 'multi') && field.allowOther === undefined) field.allowOther = true;
      if (type === 'ranking' && field.default === undefined) {
        field.default = field.options.map((option) => option.value);
      }
      break;
    }
    case 'scale': {
      field.min ??= 1;
      field.max ??= 5;
      break;
    }
    case 'slider': {
      field.min ??= 0;
      field.max ??= 100;
      field.step ??= 1;
      break;
    }
    case 'matrix': {
      if (field.rows === undefined) throw new Error(`ask_form: matrix field "${name}" needs rows`);
      if (field.options === undefined || field.options.length < 2) {
        throw new Error(`ask_form: matrix field "${name}" needs at least two shared options`);
      }
      break;
    }
    case 'budget': {
      if (field.options === undefined || field.options.length < 2) {
        throw new Error(`ask_form: budget field "${name}" needs at least two options`);
      }
      field.sumTo ??= 100;
      break;
    }
    case 'tags': {
      if (field.options !== undefined && field.options.length < 1) delete field.options;
      if (field.options !== undefined && field.allowOther === undefined) field.allowOther = true;
      break;
    }
    default:
      break;
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    throw new Error(`ask_form: field "${name}" min must not exceed max`);
  }
  if (field.visibleIf !== undefined) compileExpression(field.visibleIf);
  if (field.validate !== undefined) compileExpression(field.validate);
  return field;
}

/* -------------------------------------------------------------------------- */
/* packs: parameterized interview templates                                   */
/* -------------------------------------------------------------------------- */

const PACKS = {
  'requirement-intake': (args) => {
    const aspects = Array.isArray(args.aspects) && args.aspects.length >= 2
      ? args.aspects.map(String)
      : ['正确性', '性能', '可维护性', '交付速度', '兼容性'];
    return [
      { name: 'goal', type: 'longtext', label: `目标：${args.topic ?? '这次要达成什么'}`, help: '写清期望的结果，而不是做法。' },
      { name: 'constraints', type: 'multi', label: '硬约束（可多选，也可自己补充）', options: ['不能改依赖', '必须兼容旧数据', '必须离线可用', '有截止时间'], allow_other: true, required: false },
      { name: 'acceptance', type: 'longtext', label: '验收标准', help: '怎么算完成？可观察、可验证的判据。' },
      { name: 'priority', type: 'ranking', label: '优先级排序', options: aspects },
      { name: 'deadline', type: 'date', label: '期望完成日期', required: false },
      { name: 'open_questions', type: 'longtext', label: '还有哪些开放问题', required: false },
    ];
  },
  'design-choice': (args) => {
    const candidates = Array.isArray(args.candidates) && args.candidates.length >= 2
      ? args.candidates.map(String)
      : ['保持现状', '增量改造', '重写'];
    const criteria = Array.isArray(args.criteria) && args.criteria.length >= 2
      ? args.criteria.map(String)
      : ['成本', '风险', '长期收益'];
    return [
      { name: 'choice', type: 'single', label: args.question ?? '选哪个方案', options: candidates.map((label, index) => ({ label, ...index === 0 ? { description: '默认推荐项' } : {} })) },
      { name: 'weights', type: 'budget', label: '评价维度权重（合计 100）', options: criteria, sum_to: 100 },
      { name: 'confidence', type: 'scale', label: '你对这个选择的信心', min: 1, max: 5, anchors: { min: '很低', max: '很高' } },
      { name: 'tradeoff', type: 'longtext', label: '愿意接受的代价', help: '这个选择会牺牲什么？' },
      { name: 'revisit', type: 'longtext', label: '什么情况下需要重新评估', required: false },
    ];
  },
  'release-gate': (args) => {
    const checks = Array.isArray(args.checks) && args.checks.length >= 1
      ? args.checks.map(String)
      : ['测试通过', '没有未决的高优先级缺陷', '文档已更新', '回滚方案已就绪'];
    return [
      ...checks.map((text, index) => ({ name: `check_${index}`, type: 'confirm', label: text })),
      { name: 'blockers', type: 'longtext', label: '还有哪些阻塞项', required: false },
      { name: 'verdict', type: 'single', label: '发布结论', options: ['可以发布', '带上已知问题发布', '暂不发布'], required: false },
    ];
  },
  'incident-intake': (args) => {
    return [
      { name: 'severity', type: 'single', label: '严重程度', options: ['P0 全面不可用', 'P1 核心功能受损', 'P2 部分用户受影响', 'P3 轻微'] },
      { name: 'impact', type: 'longtext', label: `影响面：${args.system ?? '哪个系统'}`, help: '谁受影响、影响多久、有没有数据损失。' },
      { name: 'started_at', type: 'text', label: '开始时间（YYYY-MM-DD HH:mm，可估）', required: false },
      { name: 'suspected', type: 'multi', label: '怀疑原因（可多选，也可自己补充）', options: ['最近发布', '配置变更', '依赖故障', '容量不足', '未知'], allow_other: true, required: false },
      { name: 'mitigation', type: 'longtext', label: '当前已做的处置', required: false },
      { name: 'need_help', type: 'confirm', label: '需要我现在介入处理吗' },
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* compilation: form -> protocol questions (+ spec)                            */
/* -------------------------------------------------------------------------- */

/** Protocol item id for a field (or one of its rows). */
function itemId(name, rowIndex) {
  return rowIndex === undefined ? `dsh-form:${name}` : `dsh-form:${name}#${rowIndex}`;
}

/** Whether a field is currently visible under the accumulated values. */
function isVisible(field, values) {
  if (field.visibleIf === undefined) return true;
  return truthy(evaluate(field.visibleIf, values));
}

/** Public option projection used by the Client renderer. */
function optionPayload(field) {
  return (field.options ?? []).map((option) => ({
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
    value: option.value,
  }));
}

/** The spec the Client renderer reads out of `intent.spec`. */
function fieldPayload(field) {
  return {
    name: field.name,
    type: field.type,
    label: field.label,
    required: field.required,
    ...field.help === undefined ? {} : { help: field.help },
    ...field.placeholder === undefined ? {} : { placeholder: field.placeholder },
    ...field.unit === undefined ? {} : { unit: field.unit },
    ...field.pattern === undefined ? {} : { pattern: field.pattern },
    ...field.maxLength === undefined ? {} : { maxLength: field.maxLength },
    ...field.min === undefined ? {} : { min: field.min },
    ...field.max === undefined ? {} : { max: field.max },
    ...field.step === undefined ? {} : { step: field.step },
    ...field.sumTo === undefined ? {} : { sumTo: field.sumTo },
    ...field.rows === undefined ? {} : { rows: field.rows },
    ...field.anchors === undefined ? {} : { anchors: field.anchors },
    ...field.allowOther === undefined ? {} : { allowOther: field.allowOther },
    ...field.visibleIf === undefined ? {} : { visibleIf: field.visibleIf },
    ...field.validate === undefined ? {} : { validate: field.validate },
    ...field.validateMessage === undefined ? {} : { validateMessage: field.validateMessage },
    ...field.requiredMessage === undefined ? {} : { requiredMessage: field.requiredMessage },
    ...field.options === undefined ? {} : { options: optionPayload(field) },
  };
}

/**
 * Compile the form (or a subset of its fields) into protocol questions.
 * @param {object} form - normalized form.
 * @param {Record<string, unknown>} values - accumulated values (prefill).
 * @param {Array<{name: string, message: string}>} errors - previous-round failures.
 * @param {Set<string>|undefined} subset - only these field names, when re-asking.
 * @returns {{questions: object[], markerId: string, bindings: object[]}} compiled request.
 */
function compileForm(form, values, errors, subset) {
  const messages = new Map(errors.map((error) => [error.name, error.message]));
  const fields = subset === undefined ? form.fields : form.fields.filter((field) => subset.has(field.name));
  const bindings = [];
  const questions = [];

  for (const field of fields) {
    const title = field.label;
    const detail = [field.help, messages.has(field.name) ? `⚠ ${messages.get(field.name)}` : undefined]
      .filter((part) => part !== undefined && part !== '')
      .join('\n\n');
    const withDetail = (question, force) => ({
      ...question,
      ...detail !== '' || force ? { detail: detail === '' ? '' : detail } : {},
    });
    const choice = (extra) => field.options.map((option) => ({
      label: option.label,
      ...option.description === undefined ? {} : { description: option.description },
      ...extra === undefined ? {} : extra,
    }));

    switch (field.type) {
      case 'confirm':
      case 'single':
      case 'multi': {
        const id = itemId(field.name);
        questions.push(withDetail({
          id,
          question: title,
          options: choice(),
          ...field.type === 'multi' ? { multiSelect: true } : {},
        }));
        bindings.push({ name: field.name, itemId: id, kind: 'choice', field });
        break;
      }
      case 'ranking': {
        const id = itemId(field.name);
        questions.push(withDetail({
          id,
          question: title,
          detail: [detail, '请按优先级依次点选，先点的优先级最高。'].filter((part) => part !== '').join('\n\n'),
          options: choice(),
          multiSelect: true,
        }));
        bindings.push({ name: field.name, itemId: id, kind: 'ranking', field });
        break;
      }
      case 'scale':
      case 'slider': {
        const id = itemId(field.name);
        const ticks = ticksOf(field);
        if (ticks.length <= MAX_DEGRADED_TICKS) {
          questions.push(withDetail({ id, question: title, options: ticks.map((tick) => ({ label: String(tick) })) }));
        } else {
          const range = `${field.min}–${field.max}${field.unit === undefined ? '' : ` ${field.unit}`}；请输入其中的一个数值`;
          questions.push(withDetail({ id, question: `${title}（${range}）` }));
        }
        bindings.push({ name: field.name, itemId: id, kind: 'number', field });
        break;
      }
      case 'matrix': {
        field.rows.forEach((row, rowIndex) => {
          const id = itemId(field.name, rowIndex);
          questions.push(withDetail({
            id,
            question: `${title} — ${row}`,
            options: choice(),
          }, rowIndex === 0));
          bindings.push({ name: field.name, itemId: id, kind: 'matrixRow', row, field });
        });
        break;
      }
      case 'budget': {
        const unit = field.unit === undefined ? '' : field.unit;
        field.options.forEach((option, rowIndex) => {
          questions.push(withDetail({
            id: itemId(field.name, rowIndex),
            question: `${title} — ${option.label}（0–${field.sumTo}${unit === '' ? '' : ` ${unit}`}，合计需 ${field.sumTo}）`,
          }, rowIndex === 0));
          bindings.push({ name: field.name, itemId: itemId(field.name, rowIndex), kind: 'budgetRow', option, field });
        });
        break;
      }
      case 'tags': {
        const id = itemId(field.name);
        if (field.options === undefined) {
          questions.push(withDetail({ id, question: title }));
          bindings.push({ name: field.name, itemId: id, kind: 'tags', field });
        } else {
          questions.push(withDetail({ id, question: title, options: choice(), multiSelect: true }));
          bindings.push({ name: field.name, itemId: id, kind: 'choice', field, tags: true });
        }
        break;
      }
      default: {
        const id = itemId(field.name);
        const hints = [];
        if (field.type === 'number' || field.type === 'integer') {
          const bounds = [
            field.min === undefined ? undefined : `≥ ${field.min}`,
            field.max === undefined ? undefined : `≤ ${field.max}`,
          ]
            .filter(Boolean)
            .join(' 且 ');
          const unit = field.unit === undefined ? '' : ` ${field.unit}`;
          const noun = field.type === 'integer' ? '整数' : '数字';
          hints.push(`请输入${noun}${bounds === '' ? '' : `（${bounds}）`}${unit}`);
        }
        if (field.type === 'date') hints.push('格式 YYYY-MM-DD。');
        if (field.placeholder !== undefined) hints.push(field.placeholder);
        const hintText = hints.filter(Boolean).join(' ');
        questions.push(withDetail({
          id,
          question: title,
          ...hintText === '' ? {} : { detail: `${hintText}${detail === '' ? '' : `\n\n${detail}`}` },
        }));
        bindings.push({ name: field.name, itemId: id, kind: field.type === 'number' || field.type === 'integer' ? 'number' : 'text', field });
        break;
      }
    }
  }

  const markerIndex = questions.findIndex((question) => Array.isArray(question.options) && question.options.length > 0);
  let markerId;
  if (markerIndex >= 0) {
    markerId = questions[markerIndex].id;
  } else {
    markerId = 'dsh-form:__intro__';
    questions.unshift({
      id: markerId,
      header: '表单',
      question: form.title ?? '请填写这份表单',
      detail: form.intro ?? '',
      options: [{ label: '开始填写' }],
    });
  }

  const spec = {
    v: SPEC_VERSION,
    formId: form.formId,
    markerId,
    title: form.title ?? null,
    intro: form.intro ?? null,
    submitLabel: form.submitLabel ?? null,
    layout: form.layout,
    notes: form.notes ?? null,
    mode: form.mode,
    script: form.script === undefined ? null : { source: form.script.source },
    fields: fields.map(fieldPayload),
    initial: Object.fromEntries(Object.entries(values).filter(([name]) => fields.some((field) => field.name === name))),
    errors: errors.map((error) => ({ name: error.name, message: error.message })),
    rounds: form.round,
  };

  const marker = questions.find((question) => question.id === markerId);
  const approve = marker.options[0].label;
  if (marker.detail === undefined) marker.detail = '';
  marker.intent = { kind: MARKER_KIND, approve, spec };
  return { questions, markerId, bindings };
}

/* -------------------------------------------------------------------------- */
/* decoding: protocol answers -> values                                        */
/* -------------------------------------------------------------------------- */

/**
 * Decode either the Client renderer's envelope or generic option/label answers.
 * @param {Array<{id: string, selected: string[], custom?: string}>} answers - raw answers.
 * @param {object[]} bindings - compiled bindings.
 * @returns {{envelope: boolean, values: Record<string, unknown>, notes?: string, scriptError?: string, cancelled?: boolean}}
 */
function decodeAnswers(answers, bindings) {
  const carrier = answers.find((answer) => typeof answer.custom === 'string' && answer.custom.startsWith(ENVELOPE_PREFIX));
  if (carrier !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(carrier.custom.slice(ENVELOPE_PREFIX.length));
    } catch {
      return { envelope: false, values: {}, notes: undefined, scriptError: 'ask_form: the form renderer returned an unreadable envelope' };
    }
    if (parsed === null || typeof parsed !== 'object') return { envelope: false, values: {} };
    if (typeof parsed.scriptError === 'string') return { envelope: true, values: {}, scriptError: parsed.scriptError };
    if (parsed.cancelled === true) return { envelope: true, values: {}, cancelled: true };
    return {
      envelope: true,
      values: parsed.values !== null && typeof parsed.values === 'object' ? parsed.values : {},
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
    };
  }

  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const values = {};
  const labelValue = (field, label) => {
    const match = (field.options ?? []).find((option) => option.label === label);
    return match === undefined ? label : match.value;
  };
  for (const binding of bindings) {
    const answer = byId.get(binding.itemId);
    if (answer === undefined) continue;
    const selected = Array.isArray(answer.selected) ? answer.selected : [];
    const custom = typeof answer.custom === 'string' ? answer.custom.trim() : '';
    const field = binding.field;
    if (binding.kind === 'matrixRow') {
      const rowValue = custom !== '' ? custom : selected.length > 0 ? labelValue(field, selected[0]) : undefined;
      if (rowValue === undefined) continue;
      values[field.name] ??= {};
      values[field.name][binding.row] = rowValue;
      continue;
    }
    if (binding.kind === 'budgetRow') {
      const raw = custom !== '' ? custom : selected[0];
      const number = Number(raw);
      if (!Number.isFinite(number)) continue;
      values[field.name] ??= {};
      values[field.name][binding.option.label] = number;
      continue;
    }
    if (binding.kind === 'choice') {
      if (binding.tags === true) {
        const list = selected.map((label) => labelValue(field, label));
        if (custom !== '') list.push(...custom.split(/[,，、\n]/).map((part) => part.trim()).filter(Boolean));
        if (list.length > 0) values[field.name] = list;
        continue;
      }
      if (field.type === 'multi') {
        const list = selected.map((label) => labelValue(field, label));
        if (custom !== '') list.push(custom);
        if (list.length > 0) values[field.name] = list;
        continue;
      }
      const raw = custom !== '' ? custom : selected.length > 0 ? labelValue(field, selected[0]) : undefined;
      if (raw !== undefined) values[field.name] = raw;
      continue;
    }
    if (binding.kind === 'ranking') {
      const list = selected.map((label) => labelValue(field, label));
      if (custom !== '') list.push(custom);
      if (list.length > 0) values[field.name] = list;
      continue;
    }
    if (binding.kind === 'number') {
      const raw = custom !== '' ? custom : selected[0];
      if (raw === undefined) continue;
      const number = Number(raw);
      values[field.name] = Number.isFinite(number) ? number : raw;
      continue;
    }
    if (binding.kind === 'tags') {
      const raw = custom !== '' ? custom : selected.join(',');
      if (raw === '') continue;
      values[field.name] = raw.split(/[,，、\n]/).map((part) => part.trim()).filter(Boolean);
      continue;
    }
    const raw = custom !== '' ? custom : selected[0];
    if (raw !== undefined && raw !== '') values[field.name] = raw;
  }
  return { envelope: false, values };
}

/* -------------------------------------------------------------------------- */
/* host-side validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Validate one field's value.
 * @param {object} field - normalized field.
 * @param {unknown} value - decoded value.
 * @param {Record<string, unknown>} values - all values, for cross-field checks.
 * @returns {string|null} a message, or null when valid.
 */
function validateField(field, value, values) {
  if (isBlank(value)) return field.required ? field.requiredMessage ?? '此项为必填' : null;
  switch (field.type) {
    case 'confirm':
      if (typeof value === 'boolean') return null;
      if (['是', 'yes', 'true', 'y', '对', '好'].includes(String(value).toLowerCase())) return null;
      if (['否', 'no', 'false', 'n', '不'].includes(String(value).toLowerCase())) return null;
      return '需要一个是/否答案';
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
      const unknown = list.find((item) => !allowed.has(valueKey(item)));
      if (unknown !== undefined && field.type === 'single' && field.allowOther !== true) return `不在候选项中：${asString(unknown)}`;
      if (field.type === 'ranking' && field.required && list.length !== (field.options ?? []).length) {
        return `请为全部 ${(field.options ?? []).length} 个候选项排序`;
      }
      return null;
    }
    case 'multi': {
      if (field.allowOther === true) return null;
      const list = Array.isArray(value) ? value : [value];
      const allowed = new Set((field.options ?? []).map((option) => valueKey(option.value)));
      const unknown = list.find((item) => !allowed.has(valueKey(item)));
      return unknown === undefined ? null : `不在候选项中：${asString(unknown)}`;
    }
    case 'matrix': {
      const missing = (field.rows ?? []).find((row) => isBlank(value[row]));
      return missing === undefined ? null : `请为每一行选择：缺少「${missing}」`;
    }
    case 'budget': {
      const values_ = (field.options ?? []).map((option) => ({ option, number: Number(value[option.label]) }));
      const bad = values_.find((entry) => !Number.isFinite(entry.number) || entry.number < 0);
      if (bad !== undefined) return `「${bad.option.label}」需要一个不小于 0 的数字`;
      const total = values_.reduce((sum, entry) => sum + entry.number, 0);
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

/**
 * Validate every visible field, including the custom `validate` expression.
 * @param {object} form - normalized form.
 * @param {Record<string, unknown>} values - decoded values.
 * @returns {Array<{name: string, message: string}>} failures.
 */
function validateValues(form, values) {
  const errors = [];
  for (const field of form.fields) {
    if (!isVisible(field, values)) continue;
    const value = values[field.name];
    const message = validateField(field, value, values);
    if (message !== null) {
      errors.push({ name: field.name, message });
      continue;
    }
    if (field.validate !== undefined && !isBlank(value)) {
      const verdict = evaluate(field.validate, { ...values, value });
      if (!truthy(verdict)) errors.push({ name: field.name, message: field.validateMessage ?? '未通过自定义校验' });
    }
  }
  return errors;
}

/* -------------------------------------------------------------------------- */
/* form assembly                                                               */
/* -------------------------------------------------------------------------- */

/** Normalize a full `ask_form` call into the internal form. */
function normalizeForm(args) {
  if (args === null || typeof args !== 'object') throw new Error('ask_form: arguments must be an object');
  const mode = args.mode === undefined ? 'spec' : String(args.mode);
  if (!['spec', 'script'].includes(mode)) throw new Error('ask_form: mode must be "spec" or "script"');
  if (args.script !== undefined && mode !== 'script') {
    throw new Error('ask_form: a script was supplied without mode: "script"; the script escape hatch must be chosen explicitly');
  }
  let script;
  if (mode === 'script') {
    if (args.script === null || typeof args.script !== 'object' || typeof args.script.source !== 'string' || args.script.source.trim() === '') {
      throw new Error('ask_form: mode "script" requires script.source');
    }
    const fallback = args.script.fallback === undefined ? 'reject' : String(args.script.fallback);
    if (!['reject', 'fields'].includes(fallback)) throw new Error('ask_form: script.fallback must be "reject" or "fields"');
    if (fallback === 'fields' && (!Array.isArray(args.script.fallback_fields) || args.script.fallback_fields.length === 0)) {
      throw new Error('ask_form: script.fallback "fields" requires script.fallback_fields');
    }
    script = { source: args.script.source, fallback, fallbackFields: args.script.fallback_fields };
  }

  const declared = [];
  if (args.pack !== undefined) {
    const pack = PACKS[String(args.pack)];
    if (pack === undefined) throw new Error(`ask_form: unknown pack ${JSON.stringify(args.pack)}; built-ins: ${Object.keys(PACKS).join(', ')}`);
    const packArgs = args.pack_args !== null && typeof args.pack_args === 'object' ? args.pack_args : {};
    declared.push(...pack(packArgs));
  }
  if (args.fields !== undefined) {
    if (!Array.isArray(args.fields)) throw new Error('ask_form: fields must be an array');
    declared.push(...args.fields);
  }
  if (mode === 'script' && declared.length === 0 && script.fallback === 'fields') {
    declared.push(...script.fallbackFields);
  }
  if (declared.length === 0) {
    if (mode === 'script') {
      declared.push({ name: 'result', type: 'longtext', label: args.title ?? '请在表单中作答', required: false });
    } else {
      throw new Error('ask_form: at least one field, or a pack, is required');
    }
  }
  if (declared.length > MAX_FIELDS) throw new Error(`ask_form: at most ${MAX_FIELDS} fields are supported`);

  const fields = declared.map((raw, index) => normalizeField(raw, index));
  const names = new Set();
  for (const field of fields) {
    if (names.has(field.name)) throw new Error(`ask_form: duplicate field name ${JSON.stringify(field.name)}`);
    names.add(field.name);
  }
  for (const field of fields) {
    if (field.visibleIf !== undefined) compileExpression(field.visibleIf);
    if (field.validate !== undefined) compileExpression(field.validate);
  }

  const notes = args.notes === true
    ? { label: '补充说明', placeholder: '还有什么需要我知道的？' }
    : undefined;
  const maxRounds = Math.min(MAX_ROUNDS_LIMIT, Math.max(1, Number.isFinite(Number(args.max_rounds)) ? Number(args.max_rounds) : DEFAULT_MAX_ROUNDS));

  return {
    formId: `form-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    mode,
    script,
    title: typeof args.title === 'string' ? args.title : undefined,
    intro: typeof args.intro === 'string' ? args.intro : undefined,
    submitLabel: typeof args.submit_label === 'string' ? args.submit_label : undefined,
    layout: args.layout === 'steps' ? 'steps' : 'single',
    notes,
    maxRounds,
    fields,
    initial: args.initial !== null && typeof args.initial === 'object' ? args.initial : {},
    round: 0,
  };
}

/** Defaults for fields that declare one. */
function defaultsOf(form) {
  const defaults = {};
  for (const field of form.fields) {
    if (field.default !== undefined) defaults[field.name] = field.default;
  }
  return { ...defaults, ...form.initial };
}

/* -------------------------------------------------------------------------- */
/* tool registration                                                           */
/* -------------------------------------------------------------------------- */

const FIELD_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    name: { type: 'string', description: 'Answer key; an identifier (letters, digits, underscore) referenced by visible_if/validate.' },
    type: { type: 'string', enum: FIELD_TYPES, description: 'Field kind. Defaults to single.' },
    label: { type: 'string', description: 'The question shown to the user. Defaults to name.' },
    help: { type: 'string', description: 'Supporting detail rendered under the question.' },
    required: { type: 'boolean', description: 'Whether an answer is mandatory. Defaults to true.' },
    default: { description: 'Prefilled value.' },
    options: {
      type: 'array',
      description: 'Choices: "label" or {label, description?, value?}. value defaults to label.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          value: { description: 'Value returned when this option is chosen.' },
        },
        required: ['label'],
      },
    },
    min: { type: 'number', description: 'Lower bound for number/integer/scale/slider.' },
    max: { type: 'number', description: 'Upper bound for number/integer/scale/slider.' },
    step: { type: 'number', description: 'Scale/slider step. Defaults to 1.' },
    unit: { type: 'string', description: 'Unit suffix such as ms or %.' },
    anchors: {
      type: 'object',
      additionalProperties: true,
      properties: { min: { type: 'string' }, max: { type: 'string' } },
      description: 'End labels for a scale or slider, e.g. {min: "很慢", max: "很快"}.',
    },
    rows: { type: 'array', items: { type: 'string' }, description: 'matrix row labels.' },
    sum_to: { type: 'number', description: 'budget total constraint. Defaults to 100.' },
    allow_other: { type: 'boolean', description: 'Whether tags/multi accepts a free-text addition.' },
    placeholder: { type: 'string' },
    pattern: { type: 'string', description: 'Regular expression the text value must match.' },
    max_length: { type: 'number' },
    visible_if: { type: 'string', description: 'Expression over other field names, e.g. "mode == \'custom\'".' },
    validate: { type: 'string', description: 'Expression that must be truthy; `value` is this field\'s answer.' },
    validate_message: { type: 'string', description: 'Message shown when validate fails.' },
    required_message: { type: 'string', description: 'Message shown when required is unmet.' },
  },
  required: ['name'],
};

/**
 * Build the `ask_form` tool definition bound to the registering context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context owning the tool.
 * @returns {object} tool definition for `ctx.tools.register`.
 */
function createTool(ctx) {
  return {
  name: 'ask_form',
  description: [
    'Ask the user a set of structured questions as one form and return typed answers.',
    'Use it instead of ask_user_question when you need more than a flat option list: multiple typed fields in one submission, scales, ordering, matrices, weight allocation, conditional follow-ups, or answers you will consume as JSON.',
    'Field types: confirm, single, multi, text, longtext, number, integer, date, tags, scale, slider, ranking, matrix, budget. `options` accepts strings or {label, description?, value?}; put a recommended choice first (a label ending in "(Recommended)" is badged as recommended). single, multi and tags also offer a free-text answer unless you pass allow_other: false.',
    'A `pack` supplies a ready-made interview: requirement-intake, design-choice, release-gate, incident-intake, tunable through pack_args.',
    'The Host validates every visible field, re-asks only the fields that failed (up to max_rounds), and returns typed values: scale/slider/number -> number, ranking -> ordered array, matrix -> {row: choice}, budget -> {option: number}, tags -> string array.',
    'Rendering: the plugin renders one form page in the Harness Web UI. Other surfaces fall back to the generic question flow with the same fields as plain questions, and the result reports renderer as "generic" instead ("unknown" when the call ended before any renderer answered).',
    'Escape hatch: set mode: "script" plus script.source to render a custom React element. That is honored only by this plugin\'s renderer; declare script.fallback ("reject", or "fields" with fallback_fields) to say what happens elsewhere. Prefer the declarative fields; use script only when no field type expresses the interaction.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Form heading.' },
      intro: { type: 'string', description: 'Markdown shown above the fields.' },
      submit_label: { type: 'string', description: 'Submit button label.' },
      layout: { type: 'string', enum: ['single', 'steps'], description: 'single shows one page (default); steps pages through fields.' },
      fields: { type: 'array', items: FIELD_SCHEMA, description: 'Form fields, in order.' },
      pack: { type: 'string', enum: Object.keys(PACKS), description: 'Built-in question pack; its fields come before `fields`.' },
      pack_args: { type: 'object', additionalProperties: true, description: 'Pack parameters, e.g. {topic, aspects} or {candidates, criteria}.' },
      notes: { type: 'boolean', description: 'Append a free-text note field; its answer returns as `notes`.' },
      initial: { type: 'object', additionalProperties: true, description: 'Prefilled values keyed by field name.' },
      max_rounds: { type: 'number', description: `Re-ask rounds for failed fields, 1-${MAX_ROUNDS_LIMIT}. Defaults to ${DEFAULT_MAX_ROUNDS}.` },
      mode: { type: 'string', enum: ['spec', 'script'], description: 'Defaults to spec (declarative fields).' },
      script: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', description: 'JS expression evaluated to a component: (props) => ReactNode, with props = {React, h, values, setValue, setValues, spec, submit, cancel, t}.' },
          fallback: { type: 'string', enum: ['reject', 'fields'], description: 'What a renderer without script support should do. Defaults to reject.' },
          fallback_fields: { type: 'array', items: FIELD_SCHEMA, description: 'Fields compiled when fallback is "fields".' },
        },
        required: ['source'],
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['answered', 'incomplete', 'cancelled', 'aborted', 'no_answerer', 'unavailable', 'script_error'] },
        values: { type: 'object', additionalProperties: true },
        notes: { type: 'string' },
        unanswered: { type: 'array', items: { type: 'string' } },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string' }, message: { type: 'string' } },
            required: ['name', 'message'],
          },
        },
        rounds: { type: 'number' },
        renderer: { type: 'string', enum: ['form', 'generic', 'unknown'] },
        script_error: { type: 'string' },
        message: { type: 'string' },
        raw: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string' },
              selected: { type: 'array', items: { type: 'string' } },
              custom: { type: 'string' },
            },
            required: ['id', 'selected'],
          },
        },
      },
      required: ['status', 'values', 'rounds', 'renderer'],
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    const form = normalizeForm(args);
    let values = defaultsOf(form);
    let errors = [];
    let notes;
    let raw;
    let renderer = 'unknown';
    let rounds = 0;
    /** Field names the user actually answered, so a cancelled call never returns synthetic defaults. */
    const answered = new Set();
    const observed = () => Object.fromEntries(Object.entries(values).filter(([name]) => answered.has(name)));

    for (;;) {
      rounds += 1;
      form.round = rounds;
      const subset = errors.length > 0 ? new Set(errors.map((error) => error.name)) : undefined;
      const compiled = compileForm(form, values, errors, subset);
      let answer;
      try {
        answer = await ctx.userQuestions.ask({
          questions: compiled.questions,
          ...exec.agent === undefined ? {} : { agent: exec.agent },
          signal: exec.signal,
        });
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined;
        if (code === 'ASK_CANCELLED') return { status: 'cancelled', values: observed(), rounds, renderer, ...(notes === undefined ? {} : { notes }) };
        if (code === 'ASK_ABORTED') return { status: 'aborted', values: observed(), rounds, renderer, ...(notes === undefined ? {} : { notes }) };
        if (code === 'NO_PROVIDER') return { status: 'no_answerer', values: observed(), rounds, renderer, message: 'no answerer accepted the form request' };
        if (typeof code === 'string') return { status: 'unavailable', values: observed(), rounds, renderer, message: String(error.message ?? code) };
        throw error;
      }

      const decoded = decodeAnswers(answer.answers, compiled.bindings);
      renderer = decoded.envelope ? 'form' : 'generic';
      if (decoded.scriptError !== undefined) {
        return { status: 'script_error', values: observed(), rounds, renderer, script_error: decoded.scriptError };
      }
      if (decoded.cancelled === true) return { status: 'cancelled', values: observed(), rounds, renderer };
      if (!decoded.envelope && form.mode === 'script') {
        return {
          status: 'script_error',
          values: observed(),
          rounds,
          renderer,
          script_error: 'ask_form: script mode needs this plugin\'s form renderer, but the request was answered by the generic question flow. Re-ask with declarative fields, or set script.fallback to "fields".',
        };
      }
      for (const name of Object.keys(decoded.values)) answered.add(name);
      values = { ...values, ...decoded.values };
      if (decoded.notes !== undefined) notes = decoded.notes;
      if (!decoded.envelope) raw = answer.answers.map((item) => ({ id: item.id, selected: [...item.selected], ...item.custom === undefined ? {} : { custom: item.custom } }));

      errors = validateValues(form, values);
      if (errors.length === 0 || rounds >= form.maxRounds) break;
    }

    const unanswered = errors.map((error) => error.name);
    return {
      status: errors.length === 0 ? 'answered' : 'incomplete',
      values,
      ...(notes === undefined ? {} : { notes }),
      ...(unanswered.length === 0 ? {} : { unanswered }),
      ...(errors.length === 0 ? {} : { errors }),
      rounds,
      renderer,
      ...(raw === undefined ? {} : { raw }),
    };
  },
  };
}

export const name = 'ask-form';
export const inject = ['tools', 'userQuestions'];

/**
 * Register the `ask_form` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(createTool(ctx)), 'ask-form: ask_form tool');
}
