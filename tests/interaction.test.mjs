/**
 * Interaction test for the Client half of @zekilou/dsh-ask-form.
 *
 * `tests/client.test.mjs` drives the component tree with stateless hook stubs, which is enough
 * to prove structure but blind to state: it cannot see that typing into the free-text "other"
 * field lost the value, or that a tag committed on blur never reached the answer. This suite
 * runs the real tree on a small hook runtime with real `useState`/`useRef`/`useEffect`/
 * `useMemo`, so a handler can be fired and the next render inspected.
 *
 * Every form is compiled by the real Host half, so the component sees the real wire spec.
 */
import { apply as hostApply } from '../index.js';

const failures = [];
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};

/* ------------------------------------------------------------- hook runtime */

let current = null;
let dirty = false;
let effectQueue = [];
let instances = new Map();
let rootElement = null;
let renderedTree = null;

const sameDeps = (a, b) => {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  return a.every((item, index) => Object.is(item, b[index]));
};

function useState(init) {
  const slot = current;
  const index = slot.index += 1;
  if (!(index in slot.hooks)) slot.hooks[index] = typeof init === 'function' ? init() : init;
  const setter = (next) => {
    const value = typeof next === 'function' ? next(slot.hooks[index]) : next;
    if (Object.is(value, slot.hooks[index])) return;
    slot.hooks[index] = value;
    dirty = true;
  };
  return [slot.hooks[index], setter];
}
function useRef(init) {
  const slot = current;
  const index = slot.index += 1;
  if (!(index in slot.hooks)) slot.hooks[index] = { current: init };
  return slot.hooks[index];
}
function useMemo(fn, deps) {
  const slot = current;
  const index = slot.index += 1;
  const previous = slot.hooks[index];
  if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value;
  const value = fn();
  slot.hooks[index] = { value, deps };
  return value;
}
function useEffect(fn, deps) {
  const slot = current;
  const index = slot.index += 1;
  const previous = slot.hooks[index];
  if (previous !== undefined && sameDeps(previous.deps, deps)) return;
  slot.hooks[index] = { deps };
  effectQueue.push(fn);
}

const React = {
  createElement(type, props, ...children) {
    const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
    return { type, props: { ...(props ?? {}), ...(flat === undefined ? {} : { children: flat }) } };
  },
  useState,
  useRef,
  useMemo,
  useEffect,
  Component: class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }; dirty = true; }
  },
};

/** Render one element tree, giving each function component a persistent hook slot. */
function renderNode(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}[${index}]`));
  if (typeof node !== 'object') return node;
  const { type, props } = node;
  if (typeof type === 'function') {
    const isClass = type.prototype !== undefined && typeof type.prototype.render === 'function';
    if (isClass) {
      const instance = new type(props);
      return renderNode(instance.render(), `${path}#class`);
    }
    const key = `${path}|${type.name === '' ? 'anonymous' : type.name}`;
    let slot = instances.get(key);
    if (slot === undefined) { slot = { hooks: [], index: -1 }; instances.set(key, slot); }
    const outer = current;
    current = slot;
    slot.index = -1;
    let output;
    try {
      output = type(props);
    } finally {
      current = outer;
    }
    return renderNode(output, `${path}.>`);
  }
  return { type, props: { ...(props ?? {}), children: renderNode(props?.children, `${path}.c`) } };
}

function flush() {
  let guard = 0;
  for (;;) {
    dirty = false;
    renderedTree = renderNode(rootElement, 'root');
    const effects = effectQueue.splice(0);
    for (const effect of effects) effect();
    guard += 1;
    if (dirty === false || guard > 50) break;
  }
  return renderedTree;
}

/* -------------------------------------------------------------- tree helpers */

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node !== 'object') { visit({ text: String(node) }); return; }
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  visit({ element: node, className: node.props?.className });
  walk(node.props?.children, visit);
}
const textOf = (tree) => { let out = ''; walk(tree, (entry) => { if (entry.text !== undefined) out += entry.text; }); return out; };
const classesOf = (tree) => {
  const found = new Set();
  walk(tree, (entry) => { if (typeof entry.className === 'string') for (const name of entry.className.split(/\s+/)) if (name !== '') found.add(name); });
  return found;
};
const findAll = (tree, predicate) => {
  const hits = [];
  walk(tree, (entry) => { if (entry.element !== undefined && predicate(entry.element)) hits.push(entry.element); });
  return hits;
};
const findOne = (tree, predicate) => {
  const hits = findAll(tree, predicate);
  if (hits.length !== 1) throw new Error(`expected exactly one match, found ${hits.length}`);
  return hits[0];
};
const byClass = (name) => (element) => typeof element.props?.className === 'string' && element.props.className.split(/\s+/).includes(name);

/* ------------------------------------------------------- host: real compile */

let hostTool = null;
let pendingAsk = async () => { throw new Error('no scripted answerer'); };
hostApply({
  effect: (fn) => fn(),
  tools: { register: (tool) => { hostTool = tool; return () => {}; } },
  userQuestions: { ask: (request) => pendingAsk(request) },
});

let formCount = 0;
async function questionsFor(args) {
  let captured = null;
  pendingAsk = async (request) => {
    captured = request.questions;
    throw Object.assign(new Error('cancelled'), { name: 'UserQuestionError', code: 'ASK_CANCELLED' });
  };
  await hostTool.execute(args, {});
  return captured;
}

/* --------------------------------------------------------- load the bundle */

let registration = null;
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
await import(new URL('../client.js', import.meta.url).href);
const bundle = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected module request ${specifier}`);
});

let registered = null;
bundle.apply({
  slots: {
    inject: (key, callback) => { if (key !== 'conversation.composer') throw new Error(`unexpected slot ${key}`); callback(); },
    register: (options, component) => { registered = { options, component }; return () => {}; },
  },
});

/* --------------------------------------------------------------- form mount */

/**
 * Mount a form compiled by the real Host and return the handle used by the cases below.
 * Hooks are reset per mount, which is what mounting a new card on a new carrier means.
 */
async function mount(args) {
  formCount += 1;
  const questions = await questionsFor(args);
  const carrier = {
    key: `question:${formCount}`,
    kind: 'question',
    sessionId: 'session-1',
    questions,
    answered: null,
    cancelled: 0,
    answer(value) { carrier.answered = value; return Promise.resolve(); },
    cancel() { carrier.cancelled += 1; return Promise.resolve(); },
    delegate() {},
    isDelegation: () => false,
    abort() {},
  };
  instances = new Map();
  effectQueue = [];
  dirty = false;
  rootElement = React.createElement(registered.component, { matched: carrier });
  flush();
  const handler = {
    carrier,
    tree: () => renderedTree,
    text: () => textOf(renderedTree),
    classes: () => classesOf(renderedTree),
    all: (predicate) => findAll(renderedTree, predicate),
    one: (predicate) => findOne(renderedTree, predicate),
    /** Fire a synthetic event through a handler the component stored on that element. */
    fire(element, name, event = {}) {
      const fn = element.props?.[name];
      if (typeof fn !== 'function') throw new Error(`element has no ${name} handler`);
      let prevented = 0;
      fn({
        target: { value: '' },
        preventDefault() { prevented += 1; },
        stopPropagation() {},
        ...event,
      });
      flush();
      return prevented;
    },
    type(element, value) {
      handler.fire(element, 'onChange', { target: { value } });
    },
    submit() {
      handler.fire(handler.one(byClass('daf-buttonPrimary')), 'onClick');
    },
    envelope() {
      const custom = carrier.answered?.answers?.[0]?.custom;
      if (typeof custom !== 'string') return null;
      return JSON.parse(custom.slice('\u0001dsh-form:'.length));
    },
  };
  return handler;
}

const otherInput = (handle) => handle.one((element) => element.type === 'input' && typeof element.props?.['aria-label'] === 'string' && element.props['aria-label'].includes('其他'));

/* ------------------------------------------------------------ case: single */

console.log('\ncase: single + free-text other');
{
  const handle = await mount({ title: '运行时', fields: [{ name: 'runtime', type: 'single', label: '运行时', options: ['Node 22', 'Bun'] }] });
  const input = otherInput(handle);
  check('other row renders an input', input !== undefined && input.type === 'input');
  check('other row is not a dead div', handle.all(byClass('daf-otherRow')).length === 1 && typeof handle.one(byClass('daf-otherRow')).props.onClick === 'function');

  handle.type(input, 'Rust');
  check('typing marks the other row as the choice', classesOf(handle.tree()).has('daf-optionSelected') === true, [...classesOf(handle.tree())]);
  check('typed text stays in the box', otherInput(handle).props.value === 'Rust', otherInput(handle).props.value);

  handle.type(otherInput(handle), '');
  check('clearing the box unmarks the row', handle.all((element) => byClass('daf-otherRow')(element) && byClass('daf-optionSelected')(element)).length === 0);
  handle.submit();
  check('an emptied required answer blocks submit', handle.carrier.answered === null);

  handle.type(otherInput(handle), 'Rust');
  handle.submit();
  const envelope = handle.envelope();
  check('typed other answer reaches the envelope', envelope?.values?.runtime === 'Rust', envelope?.values);
}

console.log('\ncase: single + picking a listed option afterwards');
{
  const handle = await mount({ title: '运行时', fields: [{ name: 'runtime', type: 'single', label: '运行时', options: ['Node 22', 'Bun'] }] });
  handle.type(otherInput(handle), 'Rust');
  const bun = handle.one((element) => element.type === 'button' && textOf(element).includes('Bun'));
  handle.fire(bun, 'onClick');
  check('a listed option can still be picked after typing', handle.one(byClass('daf-numberChecked')) !== undefined);
  check('the other row drops its selected mark', handle.all((element) => byClass('daf-otherRow')(element) && byClass('daf-optionSelected')(element)).length === 0);
  handle.submit();
  check('the listed option wins the envelope', handle.envelope()?.values?.runtime === 'Bun', handle.envelope()?.values);
}

console.log('\ncase: single + allow_other false');
{
  const handle = await mount({ title: '封闭', fields: [{ name: 'pick', type: 'single', label: '只能选', options: ['A', 'B'], allow_other: false }] });
  check('no free-text row when the caller closes the list', handle.all((element) => typeof element.props?.['aria-label'] === 'string' && element.props['aria-label'].includes('其他')).length === 0);
}

/* ------------------------------------------------------------- case: multi */

console.log('\ncase: multi + free-text other');
{
  const handle = await mount({ title: '约束', fields: [{ name: 'constraints', type: 'multi', label: '硬约束', options: ['不能改依赖', '必须离线可用'], required: false }] });
  handle.type(otherInput(handle), '不能联网');
  check('typed text does not become a chip before Enter', classesOf(handle.tree()).has('daf-tag') === false);
  handle.fire(otherInput(handle), 'onKeyDown', { key: 'Enter' });
  const chips = handle.all(byClass('daf-tag'));
  check('Enter adds the extra as a chip', chips.length === 1 && textOf(chips[0]).includes('不能联网'), chips.length);
  check('the draft is cleared after adding', otherInput(handle).props.value === '', otherInput(handle).props.value);

  handle.type(otherInput(handle), '不能联网');
  handle.fire(otherInput(handle), 'onKeyDown', { key: 'Enter' });
  check('the same extra is not added twice', handle.all(byClass('daf-tag')).length === 1, handle.all(byClass('daf-tag')).length);

  handle.submit();
  check('extras reach the envelope', JSON.stringify(handle.envelope()?.values?.constraints) === '["不能联网"]', handle.envelope()?.values);

  const remove = handle.one(byClass('daf-chipRemove'));
  handle.fire(remove, 'onClick');
  check('a chip can be removed', handle.all(byClass('daf-tag')).length === 0);
}

console.log('\ncase: multi + a typed extra that is submitted by blur');
{
  const handle = await mount({ title: '约束', fields: [{ name: 'constraints', type: 'multi', label: '硬约束', options: ['A', 'B'], required: false }] });
  handle.type(otherInput(handle), '自填');
  // Clicking 提交 blurs the input first; the text must not be lost to the render that follows.
  handle.fire(otherInput(handle), 'onBlur', { relatedTarget: handle.one(byClass('daf-buttonPrimary')) });
  handle.submit();
  check('a blur-committed extra reaches the answer', JSON.stringify(handle.envelope()?.values?.constraints) === '["自填"]', handle.envelope()?.values);
}

console.log('\ncase: multi + extras restored from a re-ask');
{
  const handle = await mount({
    title: '约束',
    fields: [{ name: 'constraints', type: 'multi', label: '硬约束', options: ['A', 'B'], required: false }],
    initial: { constraints: ['上次自填的'] },
  });
  const chips = handle.all(byClass('daf-tag'));
  check('prefilled extras are visible as chips', chips.length === 1 && textOf(chips[0]).includes('上次自填的'), chips.length);
}

/* -------------------------------------------------------- case: number input */

console.log('\ncase: numeric input');
{
  const handle = await mount({ title: '数字', fields: [{ name: 'n', type: 'integer', label: '数量', min: 1, max: 10 }] });
  const input = handle.one((element) => element.type === 'input' && element.props?.['aria-label'] === '数量');
  handle.type(input, '1e');
  check('half-typed input never renders NaN', !handle.text().includes('NaN'), handle.text().slice(0, 80));
  check('half-typed input is kept in the box', handle.one((element) => element.type === 'input' && element.props?.['aria-label'] === '数量').props.value === '1e');
  handle.submit();
  check('unparseable input blocks submit', handle.carrier.answered === null);
  check('unparseable input is explained', handle.text().includes('需要一个数字'), handle.text().slice(-120));

  handle.type(handle.one((element) => element.type === 'input' && element.props?.['aria-label'] === '数量'), '4');
  handle.submit();
  check('a valid number submits as a number', handle.envelope()?.values?.n === 4, handle.envelope()?.values);
}

/* ------------------------------------------------------- case: budget share */

console.log('\ncase: budget split');
{
  const handle = await mount({ title: '权重', fields: [{ name: 'weights', type: 'budget', label: '权重', options: ['性能', '生态', '体积'], sum_to: 100 }] });
  handle.fire(handle.one((element) => element.type === 'button' && textOf(element).includes('平均分配')), 'onClick');
  handle.submit();
  const values = handle.envelope()?.values?.weights;
  check('average split sums to the target', values !== undefined && Math.abs(Object.values(values).reduce((sum, n) => sum + n, 0) - 100) < 1e-6, values);
  check('average split has no long decimals', values !== undefined && Object.values(values).every((n) => String(n).length <= 5), values);
}

/* ------------------------------------------------------- case: steps + notes */

console.log('\ncase: steps layout with notes');
{
  const handle = await mount({ layout: 'steps', title: '分步', notes: true, fields: [{ name: 'a', type: 'text', label: '第一题' }, { name: 'b', type: 'text', label: '第二题' }] });
  check('steps starts on the first field', handle.text().includes('第一题') && !handle.text().includes('第二题'));
  check('progress counts the notes page', handle.text().includes('1 / 3'), handle.text().match(/\d+ \/ \d+/)?.[0]);
  handle.fire(handle.one((element) => element.props?.['aria-label'] === '下一题'), 'onClick');
  handle.fire(handle.one((element) => element.props?.['aria-label'] === '下一题'), 'onClick');
  check('the notes page is reachable in steps mode', handle.one((element) => element.type === 'textarea') !== undefined);
  check('progress reached the last page', handle.text().includes('3 / 3'), handle.text().match(/\d+ \/ \d+/)?.[0]);
}

/* ------------------------------------------------------------ case: styling */

console.log('\ncase: stylesheet ownership');
{
  const handle = await mount({ title: '样式', fields: [{ name: 'x', type: 'text', label: 'X', required: false }] });
  const styles = handle.all((element) => element.type === 'style');
  check('the stylesheet is not rendered inside the tree', styles.length === 0, styles.length);
  check('the form still renders its card', classesOf(handle.tree()).has('daf-card') === true);
}

console.log(failures.length === 0 ? '\nALL INTERACTION CHECKS PASSED' : `\n${failures.length} INTERACTION CHECK(S) FAILED: ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;