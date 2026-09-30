# dsh-ask-form

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的社区插件：让模型把**结构化问题当成一份表单**来问 —— 带类型的字段、条件与校验、只重问失败项 —— 并拿回带类型的 JSON 答案。

自带的 `ask_user_question` 是一个扁平选项列表，一页一题。`ask_form` 补上了字段类型、跨字段约束和"一次提交"，并且在**无法渲染它的界面上自动降级**为自带问答流程。

[English](README.md) | 中文

## 能力

- **14 种字段类型** —— `confirm`、`single`、`multi`、`text`、`longtext`、`number`、`integer`、`date`、`tags`、`scale`、`slider`、`ranking`、`matrix`、`budget`
- **条件与校验** —— `visible_if`、`validate`（白名单表达式语言，绝不用 `eval`）、`pattern`、`max_length`、`min`/`max`、`sum_to`
- **只重问失败项** —— 每轮只补问没答对/没答的字段，上限由 `max_rounds` 控制
- **类型化结果** —— `scale`/`slider`/`number` → 数字；`ranking` → 有序数组；`matrix` → `{行: 选择}`；`budget` → `{项: 数字}`；`tags` → 字符串数组
- **预设问卷包** —— `requirement-intake`、`design-choice`、`release-gate`、`incident-intake`，用 `pack_args` 调参
- **默认带"其他"** —— `single`、`multi`、`tags` 默认接受自由文本（`allow_other: false` 可关闭）
- **逃生舱** —— `mode: "script"` 可在 Web 端渲染自定义 React 元素；其它界面由 `script.fallback` 决定行为
- **优雅降级** —— 没有本插件渲染器的界面仍会把每个字段当成普通问题发出，结果里以 `renderer: "generic"` 如实标注；script 模式则**明确报错**而不是静默降级

## 安装

前提：Harness profile 里有 `plugin_manager` 工具（`web` profile 自带）。

1. 安装 bundle —— 在 Harness 里让 agent 调用，或直接调用 `plugin_manager`：

   ```
   action: install_bundle
   target: github:Zekilou/dsh-ask-form
   ```

   本地克隆的话，把 target 换成该目录的绝对路径：`/absolute/path/to/dsh-ask-form`。

2. 刷新一次 Harness Web 页面，让客户端 bundle（`client.js`）注册进来。
3. `ask_form` 工具就会出现在 `ask_user_question` 旁边。

## 用法

一次调用就是一份表单。字段按声明顺序展示；按惯例，列表里的第一个选项是推荐项。

```json
{
  "title": "运行时选型",
  "intro": "选运行时，并给评价维度分配权重。",
  "fields": [
    { "name": "runtime", "type": "single", "label": "运行时",
      "options": ["Node 22 (Recommended)", "Bun", "Deno"] },
    { "name": "needs_wasm", "type": "confirm", "label": "需要 WASM 吗",
      "visible_if": "runtime == 'Bun'" },
    { "name": "weights", "type": "budget", "label": "维度权重（合计 100）",
      "options": ["性能", "生态", "体积"], "sum_to": 100 },
    { "name": "priority", "type": "ranking", "label": "优先级排序",
      "options": ["尽快交付", "尽量小", "可移植"] },
    { "name": "scores", "type": "matrix", "label": "逐维打分",
      "rows": ["性能", "成本"], "options": ["高", "中", "低"] }
  ],
  "notes": true
}
```

一行调用一个现成访谈：

```json
{ "pack": "requirement-intake", "pack_args": { "topic": "缓存层" }, "notes": true }
```

返回的是类型化数值加上来源信息：

```json
{ "status": "answered", "rounds": 1, "renderer": "form",
  "values": { "runtime": "Bun", "needs_wasm": true,
              "weights": { "性能": 50, "生态": 30, "体积": 20 },
              "priority": ["可移植", "尽快交付", "尽量小"],
              "scores": { "性能": "高", "成本": "低" } },
  "notes": "…" }
```

`status` 取值：`answered`、`incomplete`、`cancelled`、`aborted`、`no_answerer`、`unavailable`、`script_error`。

## 实现

两个半边，无构建步骤。

**Host 半边（`index.js`）** 在既有的 `ctx.userQuestions` seam 上注册 `ask_form` 工具：把类型化表单编译成普通的 `AskUserQuestionItem[]`（所以任何应答面都还能作答），并把完整规格通过标记题的 `intent` 带给自己的渲染器；随后既解码渲染器的 JSON 信封，也解码普通选项/标签答案，在 Host 侧校验，并只补问失败项。

**Client 半边（`client.js`）** 在 `conversation.composer` chain 里注册一个低优先级条目：只有当某个问题带着本插件的 `intent.kind` 时才接管，把整份表单渲染成**居中的浮层**（`react-dom` portal + 原生 Modal 几何），并以 JSON 信封作答。其它任何待答请求（包括 plan review）都返回 `null`，仍由自带 composer 处理 —— 所以装上这个 bundle 不会改变自带流程。

几个值得一提的行为：

- **wire 必须是无损 JSON** —— 规格要能原样通过 JSON 往返；一个"值为 `undefined`"的属性会让 Remote event 网关拒收整个请求。
- **自证探针** —— 标题为 `DSH_ASK_FORM_PROBE` 的表单会被自动作答，回传一份 DOM 报告（卡片矩形、计算样式、`elementFromPoint` 命中测试）。这个插件就是靠它在没有浏览器自动化的情况下定位问题的，以后诊断坏掉的渲染面也仍然有用。
- **提交看门狗** —— 答案 10 秒内没送达（连接被挂起或替换）就自动解开按钮并写明原因，而不是永远卡在"提交中…"。
- **bfcache 提示** —— 从后退/前进缓存恢复的页面已经失去了承载该请求的 socket，卡片会直接说明，而不是让点击无声失效。

## 自验

两套独立脚本，不需要装 monorepo，也不需要浏览器：

```sh
node tests/host.test.mjs     # 编译 -> 解码 -> 校验 -> 多轮 -> 取消
node tests/client.test.mjs   # 渲染树、标记选择器、提交信封
```

它们用桩 React（真实 React 由页面提供）驱动真实组件树，因此断言的是结构与协议，不是像素。`tests/client.test.mjs` 从 `package.json` 读取 bundle id，所以改名不会再让它们失配。

## 兼容性

- Host 半边需要 `ctx.tools` 与 `ctx.userQuestions`。
- Client 半边需要 `conversation.composer` chain，以及作为 shell seed word 的 `react-dom`（Web 端都有）。
- 针对 `0.2.0-rc.2` 时代的 pre-stable `@deepseek-ai/dsh-*` 包编写，这些 API 可能变动。

## 有意偏离自带问答卡的地方

- 浮层是**带遮罩的居中模态**，不是 composer 接管位。
- 点遮罩不关闭、Esc 也不取消 —— 避免一次误点毁掉填了一半的表单。

## 归属

客户端样式改写自 MIT 许可的 Harness 客户端包，类名统一改到本插件前缀下：

- `@deepseek-ai/dsh-client-ui-primitives` —— `Button`、`Input`、`Tag`、`SegmentedControl`、`Modal` 几何
- `@deepseek-ai/dsh-client-ui-user-questions` —— 问答卡结构、选项行、推荐标记

详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
