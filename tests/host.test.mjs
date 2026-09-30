/**
 * Offline smoke test for the Host half of @zekilou/dsh-ask-form.
 * Drives the registered ask_form tool with scripted answerers:
 *   1. the native renderer envelope (one failing round -> targeted re-ask)
 *   2. a generic (degraded) renderer answering plain protocol questions
 *   3. script mode answered generically -> explicit script_error
 *   4. conditionals/validation on the Host
 */
import { apply } from '../index.js';

let captured;
let handler = async () => { throw new Error('no scripted answerer'); };
const ctx = {
  effect: (fn) => fn(),
  tools: { register: (tool) => { captured = tool; return () => {}; } },
  userQuestions: { ask: (request) => handler(request) },
};
apply(ctx);
if (!captured || captured.name !== 'ask_form') throw new Error('tool was not registered');

const failures = [];
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};

const FIELDS = [
  { name: 'agree', type: 'confirm' },
  { name: 'mode', type: 'single', options: ['方案A', '方案B', '方案C'] },
  { name: 'count', type: 'number', min: 1, max: 5, label: '数量' },
  { name: 'nps', type: 'scale', min: 1, max: 5, anchors: { min: '低', max: '高' } },
  { name: 'order', type: 'ranking', options: ['X', 'Y', 'Z'] },
  { name: 'score', type: 'matrix', rows: ['性能', '成本'], options: ['高', '中', '低'] },
  { name: 'weights', type: 'budget', options: ['速度', '质量'], sum_to: 100 },
  { name: 'tags', type: 'tags', required: false },
  { name: 'when', type: 'date', required: false },
  { name: 'speed', type: 'slider', min: 0, max: 100, step: 10 },
  { name: 'why', type: 'longtext', required: false, visible_if: 'count > 2' },
  { name: 'checked', type: 'text', required: false, validate: 'value != "bad"', validate_message: '不能是 bad' },
];
const ARGS = { title: '测试表单', notes: true, fields: FIELDS, max_rounds: 3 };

const specOf = (questions) => {
  const marker = questions.find((question) => question.intent?.kind === 'dsh-form');
  if (marker === undefined) throw new Error('marker item missing: the spec never reached the wire');
  return { marker, spec: marker.intent.spec };
};

function nativeValues(spec, overrides = {}) {
  const values = {};
  for (const field of spec.fields) {
    switch (field.type) {
      case 'confirm': values[field.name] = true; break;
      case 'single': values[field.name] = field.options[0].value; break;
      case 'multi': values[field.name] = [field.options[0].value]; break;
      case 'ranking': values[field.name] = field.options.map((option) => option.value); break;
      case 'matrix': values[field.name] = Object.fromEntries(field.rows.map((row) => [row, field.options[0].value])); break;
      case 'budget': values[field.name] = Object.fromEntries(field.options.map((option) => [option.label, (field.sumTo ?? 100) / field.options.length])); break;
      case 'tags': values[field.name] = ['p', 'q']; break;
      case 'date': values[field.name] = '2026-01-02'; break;
      case 'number': case 'integer': values[field.name] = 3; break;
      case 'scale': case 'slider': values[field.name] = Math.round(((field.min + field.max) / 2) * 10) / 10; break;
      default: values[field.name] = 'hi'; break;
    }
  }
  return { ...values, ...overrides };
}

const envelope = (markerId, values, notes) => ({
  answers: [{
    id: markerId,
    selected: [],
    custom: `\u0001dsh-form:${JSON.stringify({ values, ...(notes === undefined ? {} : { notes }) })}`,
  }],
});

function genericAnswers(questions, spec) {
  const fields = new Map(spec.fields.map((field) => [field.name, field]));
  return questions.map((question) => {
    const name = question.id.replace(/^dsh-form:/, '').split('#')[0];
    const field = fields.get(name);
    const options = question.options ?? [];
    if (field === undefined) return { id: question.id, selected: [], custom: '' };
    switch (field.type) {
      case 'ranking': return { id: question.id, selected: options.map((option) => option.label) };
      case 'multi': return { id: question.id, selected: [options[0].label], custom: '' };
      case 'matrix': return { id: question.id, selected: [options[0].label] };
      case 'budget': return { id: question.id, selected: [], custom: String((field.sumTo ?? 100) / field.options.length) };
      case 'tags': return { id: question.id, selected: [], custom: 'p,q' };
      case 'date': return { id: question.id, selected: [], custom: '2026-01-02' };
      case 'number': case 'integer': return { id: question.id, selected: [], custom: '3' };
      case 'scale': case 'slider': return options.length > 0
        ? { id: question.id, selected: [options[Math.floor(options.length / 2)].label] }
        : { id: question.id, selected: [], custom: '50' };
      case 'confirm':
      case 'single': return { id: question.id, selected: [options[0].label] };
      default: return { id: question.id, selected: [], custom: 'hi' };
    }
  });
}

/* ------------------------------------------------ scenario 1: native form */

console.log('scenario 1: native renderer envelope, one invalid field then a targeted re-ask');
{
  const rounds = [];
  handler = async ({ questions }) => {
    const { marker, spec } = specOf(questions);
    rounds.push(spec.fields.map((field) => field.name));
    if (rounds.length === 1) return envelope(marker.id, nativeValues(spec, { count: 9, checked: 'bad' }), 'first pass');
    return envelope(marker.id, nativeValues(spec), 'final');
  };
  const result = await captured.execute(ARGS, {});
  check('two rounds', result.rounds === 2, result.rounds);
  check('round 1 had every field', rounds[0].length === FIELDS.length, rounds[0].length);
  check('round 2 asked only the failures', JSON.stringify(rounds[1].slice().sort()) === JSON.stringify(['checked', 'count']), rounds[1]);
  check('status answered', result.status === 'answered', result.status);
  check('renderer form', result.renderer === 'form', result.renderer);
  check('typed count', result.values.count === 3, result.values.count);
  check('typed ranking order', JSON.stringify(result.values.order) === '["X","Y","Z"]', result.values.order);
  check('typed matrix', result.values.score.性能 === '高' && result.values.score.成本 === '高', result.values.score);
  check('typed budget', result.values.weights.速度 === 50 && result.values.weights.质量 === 50, result.values.weights);
  check('typed scale', result.values.nps === 3, result.values.nps);
  check('confirm boolean', result.values.agree === true, result.values.agree);
  check('notes carried', result.notes === 'final', result.notes);
  check('no raw on the envelope path', result.raw === undefined, result.raw);
  check('visible_if respected (why was asked)', rounds[0].includes('why'), rounds[0]);
}

/* --------------------------------------------- scenario 2: generic renderer */

console.log('scenario 2: generic renderer answering plain protocol questions');
{
  handler = async ({ questions }) => {
    const { spec } = specOf(questions);
    return { answers: genericAnswers(questions, spec) };
  };
  const result = await captured.execute(ARGS, {});
  check('status answered', result.status === 'answered', { status: result.status, errors: result.errors });
  check('renderer generic', result.renderer === 'generic', result.renderer);
  check('count decoded from text', result.values.count === 3, result.values.count);
  check('scale decoded to number', result.values.nps === 50 || result.values.nps === 3, result.values.nps);
  check('ranking decoded in click order', JSON.stringify(result.values.order) === '["X","Y","Z"]', result.values.order);
  check('matrix decoded from rows', result.values.score?.性能 === '高' && result.values.score?.成本 === '高', result.values.score);
  check('budget decoded and summed', result.values.weights?.速度 === 50 && result.values.weights?.质量 === 50, result.values.weights);
  check('tags decoded from text', JSON.stringify(result.values.tags) === '["p","q"]', result.values.tags);
  check('confirm decoded to boolean', result.values.agree === true, result.values.agree);
  check('raw answers returned for audit', Array.isArray(result.raw) && result.raw.length > 0, result.raw?.length);
}

/* ------------------------------------------------- scenario 3: script mode */

console.log('scenario 3: script mode answered by a renderer without script support');
{
  handler = async ({ questions }) => {
    const { spec } = specOf(questions);
    return { answers: genericAnswers(questions, spec) };
  };
  const result = await captured.execute({ title: '脚本', mode: 'script', script: { source: '(p) => p.h("div")' } }, {});
  check('script_error status', result.status === 'script_error', result.status);
  check('script_error names the cause', /script mode needs/.test(result.script_error ?? ''), result.script_error);
}

console.log('scenario 3b: script mode accepted by the native renderer');
{
  handler = async ({ questions }) => {
    const { marker, spec } = specOf(questions);
    return envelope(marker.id, nativeValues(spec, { result: 'done' }), undefined);
  };
  const result = await captured.execute({ title: '脚本', mode: 'script', script: { source: '(p) => p.h("div")' } }, {});
  check('script envelope answered', result.status === 'answered' && result.renderer === 'form', { status: result.status, renderer: result.renderer });
}

/* ---------------------------------------------------- scenario 4: failures */

console.log('scenario 4: explicit script opt-in, packs, and cancellation');
{
  let message = '';
  try { await captured.execute({ fields: [{ name: 'a', type: 'single', options: ['x', 'y'] }], script: { source: 'noop' } }, {}); }
  catch (error) { message = error.message; }
  check('script without mode is refused', /mode: "script"/.test(message), message);

  handler = async ({ questions }) => {
    const { marker, spec } = specOf(questions);
    return envelope(marker.id, nativeValues(spec), undefined);
  };
  const packed = await captured.execute({ pack: 'requirement-intake', pack_args: { topic: '缓存层' } }, {});
  check('pack compiled', packed.status === 'answered' && typeof packed.values.goal === 'string', packed.status);
  check('pack ranking typed', Array.isArray(packed.values.priority), packed.values.priority);
  check('pack budget/scale typed', packed.values.deadline === '2026-01-02' && Array.isArray(packed.values.constraints), { deadline: packed.values.deadline, constraints: packed.values.constraints });

  const cancelled = { name: 'UserQuestionError', message: 'cancelled', code: 'ASK_CANCELLED' };
  handler = async () => { throw cancelled; };
  const result = await captured.execute({ fields: [{ name: 'a', type: 'text' }, { name: 'rank', type: 'ranking', options: ['x', 'y'] }] }, {});
  check('cancellation is structured', result.status === 'cancelled', result.status);
  check('cancellation hides synthetic defaults', JSON.stringify(result.values) === '{}', result.values);
  check('cancellation reports no renderer', result.renderer === 'unknown', result.renderer);
}

console.log('scenario 5: the wire payload must stay lossless JSON (the Remote event gateway rejects anything else)');
{
  /** Every question the Host sends must survive a JSON round trip unchanged. */
  /** Present-but-undefined (and other non-JSON values) are what the gateway rejects. */
  const nonJsonPaths = (value, path = '') => {
    if (value === undefined) return [path === '' ? '<root>' : path];
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return [`${path} <${typeof value}>`];
    if (typeof value === 'number' && !Number.isFinite(value)) return [`${path} <${value}>`];
    if (Array.isArray(value)) return value.flatMap((item, index) => nonJsonPaths(item, `${path}[${index}]`));
    if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => nonJsonPaths(item, `${path}.${key}`));
    return [];
  };
  const lossless = (questions, label) => {
    const offenders = nonJsonPaths(questions);
    const round = JSON.parse(JSON.stringify(questions));
    check(`lossless wire payload: ${label}`, offenders.length === 0 && JSON.stringify(round) === JSON.stringify(questions), offenders.slice(0, 5));
  };
  let seen = null;
  handler = async ({ questions }) => {
    seen = questions;
    throw Object.assign(new Error('cancelled'), { name: 'UserQuestionError', code: 'ASK_CANCELLED' });
  };
  await captured.execute({ fields: [{ name: 'a', type: 'text' }] }, {});
  lossless(seen, 'minimal args (no title/intro/notes/submit_label)');
  await captured.execute({ fields: [{ name: 'a', type: 'single', options: ['x', 'y'] }], notes: true }, {});
  lossless(seen, 'notes enabled');
  await captured.execute({ pack: 'design-choice', pack_args: { criteria: ['速度', '质量'] } }, {});
  lossless(seen, 'pack with budget');
  await captured.execute({ fields: [{ name: 'm', type: 'matrix', rows: ['r1'], options: ['a', 'b'], required: false }], initial: { m: {} } }, {});
  lossless(seen, 'matrix round with partial initial');
  let rounds = 0;
  handler = async ({ questions }) => {
    seen = questions;
    rounds += 1;
    const { marker, spec } = specOf(questions);
    return rounds === 1 ? envelope(marker.id, nativeValues(spec, { count: 9 }), undefined) : envelope(marker.id, nativeValues(spec), undefined);
  };
  await captured.execute({ fields: [{ name: 'count', type: 'number', min: 1, max: 5 }] }, {});
  lossless(seen, 'second round carrying failed values');
  check('re-ask round actually happened', rounds === 2, rounds);
}

console.log('scenario 6: single/multi offer a free-text answer by default');
{
  handler = async ({ questions }) => {
    const { marker, spec } = specOf(questions);
    return envelope(marker.id, nativeValues(spec, { mode: '自定义方案', picks: ['p1', '额外项'] }), undefined);
  };
  const open = await captured.execute({
    fields: [
      { name: 'mode', type: 'single', options: ['A', 'B'] },
      { name: 'picks', type: 'multi', options: ['p1', 'p2'] },
    ],
  }, {});
  check('free-text single accepted', open.status === 'answered' && open.values.mode === '自定义方案', { status: open.status, errors: open.errors, mode: open.values.mode });
  check('free-text multi entry accepted', JSON.stringify(open.values.picks) === '["p1","额外项"]', open.values.picks);

  handler = async ({ questions }) => {
    const { marker, spec } = specOf(questions);
    return envelope(marker.id, nativeValues(spec, { mode: '自定义方案' }), undefined);
  };
  const closed = await captured.execute({ max_rounds: 1, fields: [{ name: 'mode', type: 'single', options: ['A', 'B'], allow_other: false }] }, {});
  check('allow_other false rejects an unknown value', closed.status === 'incomplete' && (closed.errors ?? []).some((error) => error.name === 'mode'), { status: closed.status, errors: closed.errors });
  let wire = null;
  handler = async ({ questions }) => {
    wire = questions;
    throw Object.assign(new Error('cancelled'), { name: 'UserQuestionError', code: 'ASK_CANCELLED' });
  };
  await captured.execute({ fields: [{ name: 'mode', type: 'single', options: ['A', 'B'] }] }, {});
  const specFields = specOf(wire).spec.fields;
  check('the default is stated in the wire spec', specFields[0].allowOther === true, specFields[0]);
  check('an explicit opt-out reaches the wire', await (async () => {
    await captured.execute({ fields: [{ name: 'mode', type: 'single', options: ['A', 'B'], allow_other: false }] }, {});
    return specOf(wire).spec.fields[0].allowOther === false;
  })(), specOf(wire).spec.fields[0]);
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
