/**
 * Offline browser lab for the Client half of `@zekilou/dsh-ask-form`.
 *
 * The Host half is real: this server registers the `ask_form` tool through its own `apply`,
 * asks it once per page load, and captures the questions the tool would have pushed onto the
 * wire. The Client half is real too: `client.js` is served untouched and registers into a
 * minimal `window.__ModuleLoader__` shim. React 18 comes from `tests/lab/vendor/`.
 *
 * So a page here renders the exact payload the harness would deliver, with the exact
 * component tree the harness would mount — without a harness, a profile, or a live session.
 *
 *   node tests/lab/serve.mjs [--port 7321]
 *
 * Routes:
 *   /                     lab shell (renders whatever form `?form=` names)
 *   /client.js            the real bundle
 *   /payload.json?form=X  real host-compiled questions + spec for form X
 *   /vendor/*             React + ReactDOM UMD
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

/* ------------------------------------------------------------------ forms */

const FORMS = {
  /** single + default free-text "other" — the reported bug. */
  single: {
    title: 'Runtime decision',
    intro: '选一个运行时；如果都不合适，就在「其他」里直接写。',
    fields: [
      { name: 'runtime', type: 'single', label: '运行时', options: ['Node 22 (Recommended)', 'Bun', 'Deno'] },
      { name: 'why', type: 'longtext', label: '为什么', required: false },
    ],
  },
  /** multi + free-text: typed extras have no chip in the UI. */
  multi: {
    title: '约束（多选）',
    fields: [
      { name: 'constraints', type: 'multi', label: '硬约束（可多选，也可自己补充）', options: ['不能改依赖', '必须兼容旧数据', '必须离线可用'], required: false },
    ],
  },
  /** tags without options: the chip editor. */
  tags: {
    title: '标签',
    fields: [
      { name: 'labels', type: 'tags', label: '打几个标签', required: false },
    ],
  },
  /** closed list: allow_other: false must not render the other row. */
  closed: {
    title: '封闭选项',
    fields: [
      { name: 'pick', type: 'single', label: '只能选这几个', options: ['A', 'B'], allow_other: false },
    ],
  },
  /** every non-choice control on one page. */
  kitchen: {
    title: '全部控件',
    fields: [
      { name: 'ok', type: 'confirm', label: '要继续吗' },
      { name: 'n', type: 'integer', label: '数量', min: 1, max: 10, unit: '个' },
      { name: 'when', type: 'date', label: '日期', required: false },
      { name: 'conf', type: 'scale', label: '信心', min: 1, max: 5, anchors: { min: '很低', max: '很高' } },
      { name: 'pct', type: 'slider', label: '比例', min: 0, max: 100, unit: '%' },
      { name: 'rank', type: 'ranking', label: '优先级', options: ['快', '小', '稳'] },
      { name: 'score', type: 'matrix', label: '评分', rows: ['性能', '成本'], options: ['高', '中', '低'] },
      { name: 'weights', type: 'budget', label: '权重', options: ['性能', '生态'], sum_to: 100 },
      { name: 'note2', type: 'text', label: '其他备注', required: false },
    ],
    notes: true,
  },
  /** one conditionally visible field. */
  conditional: {
    title: '条件字段',
    fields: [
      { name: 'mode', type: 'single', label: '模式', options: ['默认', '自定义'], allow_other: false },
      { name: 'custom', type: 'text', label: '自定义值（只有选自定义才出现）', visible_if: "mode == '自定义'", required: false },
    ],
  },
  /** steps layout. */
  steps: {
    layout: 'steps',
    title: '分步表单',
    fields: [
      { name: 'a', type: 'text', label: '第一题' },
      { name: 'b', type: 'text', label: '第二题' },
      { name: 'c', type: 'text', label: '第三题' },
    ],
  },
  /** required text left empty: submit must show an error and not answer. */
  required: {
    title: '必填校验',
    fields: [
      { name: 'goal', type: 'longtext', label: '目标' },
    ],
  },
  /** steps layout plus the notes block: the notes page is the last step. */
  stepsnotes: {
    layout: 'steps',
    title: '分步 + 补充说明',
    notes: true,
    fields: [
      { name: 'a', type: 'text', label: '第一步' },
      { name: 'b', type: 'text', label: '第二步' },
    ],
  },
  /** the shape of a second round: the same form, carrying the previous failure. */
  reask: {
    title: '第二轮追问',
    fields: [
      { name: 'goal', type: 'longtext', label: '目标' },
      { name: 'runtime', type: 'single', label: '运行时', options: ['Node 22', 'Bun'] },
    ],
  },
};

/* --------------------------------------------------------------- host tool */

/** Register the real `ask_form` tool with a fake context and capture its questions. */
async function loadHost() {
  const mod = await import(join(repo, 'index.js'));
  let tool = null;
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
    tools: { register(definition) { tool = definition; return () => { tool = null; }; } },
  };
  mod.apply(ctx);
  if (tool === null) throw new Error('host half did not register ask_form');

  return async function compile(args) {
    let captured = null;
    const hostCtx = {
      userQuestions: {
        ask(request) {
          captured = request;
          // Stay pending forever: the lab only needs what the Host put on the wire.
          return new Promise(() => {});
        },
      },
    };
    // Swap the ctx the tool closed over: re-register against a ctx carrying userQuestions.
    const scoped = {
      effect(fn) { fn(); },
      tools: { register(definition) { tool = definition; return () => {}; } },
      ...hostCtx,
    };
    mod.apply(scoped);
    tool.execute(args, {}).catch(() => {});
    const started = Date.now();
    while (captured === null && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 5));
    if (captured === null) throw new Error('host half never asked');
    return captured;
  };
}

/* ----------------------------------------------------------------- server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function safeJoin(base, target) {
  const path = normalize(join(base, target));
  if (!path.startsWith(base)) throw new Error(`refusing to serve ${target}`);
  return path;
}

async function main() {
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 7321;
  const compile = await loadHost();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    try {
      if (url.pathname === '/') {
        const html = await readFile(join(here, 'lab.html'));
        return send(200, html, MIME['.html']);
      }
      if (url.pathname === '/client.js' || url.pathname === '/client-old.js') {
        // `?client=old` serves the last committed bundle, so a fix can be seen side by side.
        const client = url.pathname === '/client.js'
          ? await readFile(join(repo, 'client.js'))
          : execFileSync('git', ['show', 'HEAD:client.js'], { cwd: repo, encoding: 'utf8' });
        return send(200, client, MIME['.js']);
      }
      if (url.pathname === '/payload.json') {
        const name = url.searchParams.get('form') ?? 'single';
        const args = FORMS[name];
        if (args === undefined) return send(404, JSON.stringify({ error: `unknown form ${name}`, forms: Object.keys(FORMS) }), MIME['.json']);
        const request_ = await compile(args);
        const questions = request_.questions;
        if (url.searchParams.get('errors') === '1') {
          const spec = questions.find((question) => question.intent !== undefined)?.intent?.spec;
          if (spec !== null && spec !== undefined) spec.errors = [{ name: spec.fields[0].name, message: '此项为必填（来自第二轮的提示）' }];
        }
        return send(200, JSON.stringify({ form: name, questions }), MIME['.json']);
      }
      if (url.pathname.startsWith('/vendor/')) {
        const file = await readFile(safeJoin(join(here, 'vendor'), url.pathname.slice('/vendor/'.length)));
        return send(200, file, MIME['.js']);
      }
      if (url.pathname === '/forms.json') return send(200, JSON.stringify(Object.keys(FORMS)), MIME['.json']);
      return send(404, `no route ${url.pathname}`);
    } catch (error) {
      return send(500, `${error?.stack ?? error}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`ask-form lab on http://127.0.0.1:${port}/`);
    console.log(`forms: ${Object.keys(FORMS).join(', ')}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});