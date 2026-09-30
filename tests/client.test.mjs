/**
 * Offline smoke test for the Client half of @zekilou/dsh-ask-form.
 *
 * React is not resolvable outside the page, so this drives the bundle with a minimal
 * createElement/hooks stub: enough to walk the real component tree, assert which controls
 * render, exercise the marker selector, and click the real submit button through the real
 * validation and envelope path.
 */
import { apply as hostApply } from '../index.js';

const failures = [];
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};

/* ------------------------------------------------------- minimal React stub */

const React = {
  createElement(type, props, ...children) {
    const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
    return { type, props: { ...(props ?? {}), ...(flat === undefined ? {} : { children: flat }) } };
  },
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useMemo(fn) { return fn(); },
  useRef(init) { return { current: init }; },
  useEffect() {},
  Component: class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }; }
  },
};

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') { visit({ text: String(node) }); return; }
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  visit({ element: node, className: node.props?.className });
  if (typeof node.type === 'function') {
    const isClass = node.type.prototype !== undefined && typeof node.type.prototype.render === 'function';
    if (isClass) {
      const instance = new node.type(node.props);
      walk(instance.render(), visit);
    } else {
      walk(node.type(node.props), visit);
    }
    return;
  }
  walk(node.props?.children, visit);
}
const textOf = (node) => { let out = ''; walk(node, (entry) => { if (entry.text !== undefined) out += entry.text; }); return out; };
const classesOf = (node) => { const found = new Set(); walk(node, (entry) => { if (typeof entry.className === 'string') for (const name of entry.className.split(/\s+/)) if (name !== '') found.add(name); }); return found; };
const findElement = (node, predicate) => {
  let hit = null;
  walk(node, (entry) => { if (hit === null && entry.element !== undefined && entry.element.type !== undefined && predicate(entry.element)) hit = entry.element; });
  return hit;
};

/* ------------------------------------------------------ Host tool under test */

let hostTool;
let pendingAsk = async () => { throw new Error('no scripted answerer'); };
hostApply({
  effect: (fn) => fn(),
  tools: { register: (tool) => { hostTool = tool; return () => {}; } },
  userQuestions: { ask: (request) => pendingAsk(request) },
});

/** Run the Host once against a cancelling answerer and return the wire questions it produced. */
async function questionsFor(args) {
  let captured = null;
  pendingAsk = async (request) => {
    captured = request.questions;
    throw Object.assign(new Error('cancelled'), { name: 'UserQuestionError', code: 'ASK_CANCELLED' });
  };
  await hostTool.execute(args, {});
  return captured;
}

/* ------------------------------------------------------------ load the bundle */

let registration = null;
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
await import(new URL('../client.js', import.meta.url).href);
const PACKAGE_NAME = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(new URL('../package.json', import.meta.url), 'utf8'))).name;
if (registration === null || registration.id !== PACKAGE_NAME) throw new Error(`the client bundle registered as ${registration?.id}, expected ${PACKAGE_NAME}`);

const bundle = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected module request ${specifier}`);
});
check('bundle injects only slots', JSON.stringify(bundle.inject) === '["slots"]', bundle.inject);

let registered = null;
bundle.apply({
  slots: {
    inject: (key, callback) => { if (key !== 'conversation.composer') throw new Error(`unexpected slot ${key}`); callback(); },
    register: (options, component) => { registered = { options, component }; return () => {}; },
  },
});
check('registers one composer entry', registered !== null && registered.options.name === 'conversation.composer', registered?.options);
check('entry is tried before the packed composer', registered.options.priority < 0, registered.options.priority);

/* ---------------------------------------------------------------- selector */

const makeCarrier = (list) => ({
  key: 'question:1',
  kind: 'question',
  sessionId: 'session-1',
  questions: list,
  answer: (value) => { makeCarrier.lastAnswer = value; return Promise.resolve(); },
  cancel: () => { makeCarrier.cancellations = (makeCarrier.cancellations ?? 0) + 1; return Promise.resolve(); },
  delegate: () => {},
  isDelegation: () => false,
  abort: () => {},
});
const select = (pendingInteraction) => registered.options.select({ pendingInteraction });
const planReview = makeCarrier([{ id: 'q', question: 'p', detail: 'd', options: [{ label: 'a' }], intent: { kind: 'plan-review', approve: 'a' } }]);

/* ------------------------------------------------------------- render checks */

const FIELDS = [
  { name: 'agree', type: 'confirm', required: false },
  { name: 'mode', type: 'single', options: ['方案A (Recommended)', '方案B'], required: false },
  { name: 'picks', type: 'multi', options: ['p1', 'p2'], required: false },
  { name: 'count', type: 'number', min: 1, max: 5, required: false },
  { name: 'nps', type: 'scale', min: 1, max: 5, anchors: { min: '低', max: '高' }, required: false },
  { name: 'order', type: 'ranking', options: ['X', 'Y', 'Z'], required: false },
  { name: 'score', type: 'matrix', rows: ['性能', '成本'], options: ['高', '中', '低'], required: false },
  { name: 'weights', type: 'budget', options: ['速度', '质量'], sum_to: 100, required: false },
  { name: 'tags', type: 'tags', required: false },
  { name: 'when', type: 'date', required: false },
  { name: 'speed', type: 'slider', min: 0, max: 100, step: 10, required: false },
  { name: 'why', type: 'longtext', required: false },
];
const INITIAL = {
  agree: true,
  mode: '方案A (Recommended)',
  picks: ['p1'],
  count: 4,
  nps: 5,
  order: ['Z', 'Y', 'X'],
  score: { 性能: '高', 成本: '低' },
  weights: { 速度: 70, 质量: 30 },
  tags: ['alpha', 'beta'],
  when: '2026-03-04',
  speed: 40,
  why: 'because',
};

const questions = await questionsFor({ title: '测试表单', intro: '请按实际情况填写', notes: true, fields: FIELDS });
check('Host produced questions', Array.isArray(questions) && questions.length > 0, questions?.length);
const marker = questions.find((question) => question.intent?.kind === 'dsh-form');
check('spec rides in the marker intent', marker !== undefined && Array.isArray(marker.intent.spec.fields), marker?.id);
check('marker id is inside the spec', marker !== undefined && marker.intent.spec.markerId === marker.id, marker?.intent?.spec?.markerId);
check('spec stays invisible to generic renderers', marker !== undefined && typeof marker.detail === 'string');

const carrier = makeCarrier(questions);
check('selector claims the marked request', select(carrier) === carrier);
check('selector ignores a plan review', select(planReview) === null);
check('selector ignores approvals', select({ key: 'approval:1', kind: 'approval', sessionId: 's' }) === null);
check('selector ignores nothing pending', select(undefined) === null);

const tree = registered.component({ matched: carrier });
const classes = classesOf(tree);
const text = textOf(tree);
check('component returns null for a foreign request', registered.component({ matched: makeCarrier([{ id: 'x', intent: { kind: 'other', spec: { fields: [] } } }]) }) === null);
check('title rendered', text.includes('测试表单'), text.slice(0, 60));
check('intro rendered', text.includes('请按实际情况填写'));
for (const [label, name] of [['选项行', 'daf-option'], ['单选标记', 'daf-number'], ['复选标记', 'daf-checkbox'], ['刻度', 'daf-segment'], ['滑块', 'daf-range'], ['排序行', 'daf-rankRow'], ['矩阵', 'daf-matrix'], ['权重行', 'daf-budgetRow'], ['标签输入', 'daf-tagInput'], ['长文本', 'daf-textarea'], ['提交按钮', 'daf-buttonPrimary'], ['日期输入', 'daf-input']]) {
  check(`renders ${label}`, classes.has(name) === true);
}
check('all field labels rendered', FIELDS.every((field) => text.includes(field.label ?? field.name)), FIELDS.filter((field) => !text.includes(field.label ?? field.name)).map((field) => field.name));
check('recommended badge rendered', text.includes('推荐'));
check('scale anchors rendered', text.includes('低') && text.includes('高'));
check('budget total rendered', text.includes('合计 0 / 100'), text.match(/合计[^|]{0,16}/)?.[0]);
check('no required marker when nothing is required', classes.has('daf-req') === false);
check('a free-text answer is offered by default', findElement(tree, (element) => typeof element.props?.placeholder === 'string' && element.props.placeholder.includes('回车')) !== null);
check('ranking default order shown', text.includes('1') && text.includes('X') && text.includes('Z'));

/* ------------------------------------------------------- validation blocks */

const requiredQuestions = await questionsFor({ title: '必填', fields: [{ name: 'needed', type: 'text', label: '必填项' }] });
makeCarrier.lastAnswer = null;
const requiredTree = registered.component({ matched: makeCarrier(requiredQuestions) });
check('required marker rendered', classesOf(requiredTree).has('daf-req') === true);
findElement(requiredTree, (element) => typeof element.props?.className === 'string' && element.props.className.includes('daf-buttonPrimary')).props.onClick();
check('empty required field blocks submit', makeCarrier.lastAnswer === null, makeCarrier.lastAnswer);

/* ------------------------------------------------------------ submit envelope */

makeCarrier.lastAnswer = null;
const filled = await questionsFor({ title: '测试表单', fields: FIELDS, initial: INITIAL });
const filledCarrier = makeCarrier(filled);
const filledTree = registered.component({ matched: filledCarrier });
check('tags chips rendered from initial values', classesOf(filledTree).has('daf-tag') === true);
findElement(filledTree, (element) => typeof element.props?.className === 'string' && element.props.className.includes('daf-buttonPrimary')).props.onClick();

check('prefilled form submits', makeCarrier.lastAnswer !== null);
const envelope = makeCarrier.lastAnswer?.answers?.[0];
check('answer uses the marker id', envelope?.id === filledCarrier.questions.find((question) => question.intent?.kind === 'dsh-form').id, envelope?.id);
check('answer carries the sentinel', typeof envelope?.custom === 'string' && envelope.custom.startsWith('\u0001dsh-form:'), envelope?.custom?.slice(0, 12));
const decoded = JSON.parse(envelope.custom.slice('\u0001dsh-form:'.length));
check('envelope carries every typed value', JSON.stringify(decoded.values) === JSON.stringify(INITIAL), decoded.values);
check('values keep real types', decoded.values.agree === true && decoded.values.count === 4 && Array.isArray(decoded.values.order) && decoded.values.score.成本 === '低', decoded.values);
check('notes omitted while empty', decoded.notes === undefined, decoded.notes);

/* ------------------------------------------------------------------ cancel */

findElement(tree, (element) => element.props?.['aria-label'] === '放弃整组问题').props.onClick();
check('cancel reaches the carrier', makeCarrier.cancellations === 1, makeCarrier.cancellations);

console.log(failures.length === 0 ? '\nALL CLIENT CHECKS PASSED' : `\n${failures.length} CLIENT CHECK(S) FAILED: ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
