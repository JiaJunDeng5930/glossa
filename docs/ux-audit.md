# Glossa 用户体验全面审计

- 审计日期：2026-07-11
- 审计基线：`311f7b6`
- 审计分支：`audit/user-experience`
- 审计对象：官网与安装、首次设置、弹窗、页面释义、选词制卡、设置、词汇状态、缓存、错误恢复、响应式与可访问性

## 结论

Glossa 已经具备统一、克制、辨识度很高的视觉系统，核心体验目前受三项产品语义错误主导：

1. 同一拼写的不同语境共用一份卡片缓存和一条重复制卡记录，用户可能把旧词义写入新的 Anki 卡片。
2. 扫描器按单个文本节点提取语境，制卡又从注入释义后的父元素读取文本，“完整句子”会被截断、扩大成整段，或混入中文释义副本。
3. 一个词只要成功显示过一次释义就会进入 `known`，随后受缓存有效期影响继续显示或消失；界面把这一状态称为“已掌握”。

本轮共记录 35 项问题：3 项 P0、16 项 P1、14 项 P2、2 项 P3。P0 与 P1 会直接影响卡片正确性、词汇学习结果、首次可用性、数据信任和核心任务可达性。

## 方法与证据

本轮使用以下证据源：

- 阅读 `manifest.json`、官网、README、onboarding、popup、options、content、background、core、storage 和现有测试。
- 执行 `npm run build`，在 1280×720、400×600、320×720 视口检查官网、onboarding、popup、options 和页面 UI 预览。
- 检查浏览器语义树、键盘路径、弹窗、对话框、未保存状态、窄屏布局和可见状态反馈。
- 运行针对扫描器、词表、缓存和注入 DOM 的小型实验。
- 真实 AI 计费请求与个人 Anki 写入由源码路径和现有测试覆盖；本轮浏览器交互使用仓库内本地 mock。

关键实测结果：

| 实验 | 结果 |
| --- | --- |
| Onboarding 使用空 API key、未连接 Anki 连续点击“继续” | 到达“可以开始阅读”与 `8 / 8` |
| 设置页把学习窗口从 3 改为 9 后直接刷新 | 保存状态从 `dirty` 回到 `clean`，输入恢复为 3，全程无离页提示 |
| OpenAI Responses 连接测试收到本地 mock 的 `{ "items": [] }` | 按钮进入 `success`，状态文本为空；该响应不符合真实 Responses 输出契约 |
| 320px 设置页 | `clientWidth = 305`、`scrollWidth = 320`，出现横向滚动条 |
| 320px 已掌握词汇对话框 | 对话框与词汇列表形成双层纵向滚动，空数据仍渲染 A–Z 26 个分组 |
| 已掌握词汇输入 `testword` 后按 Enter | 输入仍为 `testword`，记录数仍为 0；点击“添加”后才写入 |
| 注入两个释义后的段落 `textContent` | 每个释义出现两份：隐藏宽度探针一份、可见标签一份 |
| `<p>A <em>quizzical</em> bank appears in a complicated context.</p>` 扫描 | `quizzical` 被跳过，送出的语境从 `bank appears...` 开始 |
| 词表集合检查 | CET-6 缺少 CET-4 中 3492 个词；CET-6、TOEFL、GRE 均缺少 `the/of/and/to/a/in/is/it/you/that` |

## 优先级定义

| 级别 | 定义 |
| --- | --- |
| P0 | 核心任务会生成错误学习数据、错误卡片或错误词汇状态 |
| P1 | 首次使用、核心任务、信任、安全感或无障碍路径受到明显阻断 |
| P2 | 高频摩擦、恢复困难、跨页面兼容或响应式问题 |
| P3 | 文案、视觉表达和低频边缘体验 |

## 问题索引

| ID | 级别 | 旅程 | 问题 |
| --- | --- | --- | --- |
| UX-001 | P0 | 制卡 | 卡片缓存与重复判定只看 `lang:lemma`，不同语境和词义会复用旧卡片 |
| UX-002 | P0 | 释义与制卡 | 扫描语境按文本节点截断，制卡语境会扩大成父元素并混入注入释义 |
| UX-003 | P0 | 词汇学习 | 成功显示一次释义就把词标记为 `known`，缓存又决定它何时消失 |
| UX-004 | P1 | 首次设置 | 空 API key、未连接 Anki 仍可完成引导并看到“可以开始阅读” |
| UX-005 | P1 | 首次设置 | 八步流程只提供继续/完成，关闭后缺少恢复、返回、跳过和重新打开入口 |
| UX-006 | P1 | 信任与隐私 | 全站、全 frame 注入和句子外发缺少就地披露、站点范围和逐站控制 |
| UX-007 | P1 | 熟词过滤 | 词表只能单选且缺少关闭项，考试词表未形成累计知识层级 |
| UX-008 | P1 | 设置 | 已打开页面只在启动时读取外观、快捷键、自动翻译和词表，保存后继续使用旧值 |
| UX-009 | P1 | AI 设置 | 持久释义缓存身份忽略 provider、model 和 prompt，改动后的输出仍可能沿用旧结果 |
| UX-010 | P1 | 缓存恢复 | “清空翻译缓存”只清 IndexedDB，页面内存缓存继续命中；错误释义缺少可靠刷新路径 |
| UX-011 | P1 | 制卡 | Alt+点击会直接生成并写入 Anki，缺少内容预览、编辑、撤销和创建数量反馈 |
| UX-012 | P1 | 可达性 | 制卡依赖按住快捷键再鼠标点击，键盘用户和触屏用户缺少等价路径 |
| UX-013 | P1 | 状态反馈 | 释义和制卡状态依赖省略号、颜色、背景和 title，缺少可见语义与实时辅助技术播报 |
| UX-014 | P1 | 弹窗 | “已准备 / Ready”是固定文案，无法表达受限页面、启动中、已开启、已关闭或失败状态 |
| UX-015 | P1 | 设置 | 未保存改动在刷新、关闭或跳转时直接丢失 |
| UX-016 | P1 | 快捷键 | 快捷键可冲突、可拦截网页输入，捕获过程缺少取消与冲突检查 |
| UX-017 | P1 | 连接测试 | AI 测试把任意 HTTP 200 JSON 当作成功，可能给出错误的“连接可用”判断 |
| UX-018 | P1 | 等待与取消 | 默认制卡等待预算可达 95 秒，释义请求可重试两次；界面只显示 `...` 且缺少取消、队列和进度 |
| UX-019 | P1 | 数据控制 | `cardCache`、`cardedWords`、learning/ignored 状态缺少查看、删除、导出和完整重置入口 |
| UX-020 | P2 | 页面能力 | 受限页面、零候选词、全部被过滤和内容脚本启动失败缺少明确结果与就地恢复动作 |
| UX-021 | P2 | 错误恢复 | 部分弹窗异常直接显示 Chrome 英文错误，页面错误徽标缺少可见详情和重试按钮 |
| UX-022 | P2 | 操作可靠性 | Onboarding 保存失败、词汇增删失败和首次词汇读取失败缺少稳定的可见反馈 |
| UX-023 | P2 | Anki 设置 | 引导缺少 AnkiConnect 安装入口；设置页打开即顺序检查每个模型字段，牌组与模板期间被禁用 |
| UX-024 | P2 | 词汇管理 | 空列表仍渲染 26 个分组，窄屏形成双层滚动，Enter 无法添加，文案暴露内部词 `known` |
| UX-025 | P2 | 数据删除 | 清空已掌握词汇、清空翻译缓存、移除单词均直接执行，缺少确认、撤销和进度状态 |
| UX-026 | P2 | 词汇管理 | 手动添加仅做小写化，短语、中文和无效字符均可写入；缺少搜索、批量导入和批量导出 |
| UX-027 | P2 | 释义密度 | 每次扫描每个 lemma 最多显示一次，短词和全大写词直接跳过，用户无法调节密度或规则 |
| UX-028 | P2 | 页面兼容 | 标签宽度无上限并改变行高、字间距和换行；页面 CSS、overflow 和长模型输出可破坏显示 |
| UX-029 | P2 | 页面文本 | 注入的标签和宽度探针进入 `textContent`，复制、朗读和依赖页面文本的脚本会收到额外内容 |
| UX-030 | P2 | 响应式 | 320px 设置页出现横向滚动；移动端全局状态远离 AI/Anki 操作；重复确认会遮住正文 |
| UX-031 | P2 | 重复确认 | 自定义 `role=dialog` 缺少 `aria-modal` 与焦点圈闭，默认 5 秒自动消失且无倒计时 |
| UX-032 | P2 | 配置表单 | provider 无关字段持续显示，Glossa Backend 的 API key 无效，legacy completions 的推理强度无效 |
| UX-033 | P2 | 页面状态 | SPA 路由变化会把手动开启状态重置为自动翻译设置，界面没有说明当前作用范围 |
| UX-034 | P3 | 安装与承诺 | 官网“三步开始阅读”省略八步设置、全站权限、手动更新和开发者模式长期成本 |
| UX-035 | P3 | 文案与细节 | 中文界面混入 Reader control、Ready、Live reading proof、Reading sample 和内部术语；滑杆缺少数值显示与对比度检查 |

## P0 详细问题

### UX-001：卡片身份忽略语境和词义

`buildCardCacheKey` 只包含语言、目标语言、prompt 版本和 lemma；句子、词义、页面和模型均未进入身份。重复制卡记录也使用同一个 `lang:lemma` 键。证据：

- `src/core/cache.ts:24-38`
- `src/background/messages.ts:78-109`
- `src/background/messages.ts:118-128`

用户场景：

1. 用户在金融文章里为 `bank` 制卡，缓存得到“银行”。
2. 用户在河流文章里点击 `bank`，系统先提示“已经制过卡”。
3. 用户确认继续后，系统按 lemma 命中旧 `cardCache`，新卡仍使用金融语境内容。

这会把错误内容永久写入个人 Anki。产品需要先定义卡片唯一性：词形、lemma、词义、句子实例或用户确认后的内容版本。实现前应确定这项状态模型。

### UX-002：上下文采集与“完整句子”承诺不一致

页面扫描在每个文本节点内部运行句子正则，并要求单个文本节点至少 12 个字符。常见的链接、强调、行内 span 会切断句子。实测 `<em>quizzical</em>` 因独立节点不足 12 字符而消失，后续 token 收到的上下文从 `bank appears...` 开始。证据：

- `src/content/scanner.ts:56-57`
- `src/content/scanner.ts:98-108`
- `src/content/scanner.ts:130-181`
- `website/public/index.html:129-137`

制卡路径又使用点击元素或 wrapper 父元素的 `textContent`。释义 wrapper 内含隐藏宽度探针、可见释义和原词，父元素会收到两份中文释义；普通点击还可能把整段、整张卡片或按钮文案作为“句子”。证据：

- `src/content/selection.ts:227-260`
- `src/content/overlay.ts:558-577`

这同时影响释义准确性、卡片内容、复制文本和辅助技术朗读。语境抽取应共享一个基于 DOM Range 的句子模型，扫描、显示与制卡统一使用同一份原始文本快照。

### UX-003：一次曝光被当作掌握，缓存控制显示寿命

`markRecordShown` 会把 `candidate` 直接改为 `known`；`learning_active` 到期后也直接改为 `known`。证据：

- `src/core/state.ts:34-41`
- `src/core/state.ts:54-59`
- `src/background/glossResolver.ts:676-681`

解析顺序先查页面内存与持久释义缓存，再查 `known`。因此一个词第一次显示后已经进入已掌握状态，缓存新鲜时仍显示，缓存过期或被清理后才隐藏。证据：

- `src/background/glossResolver.ts:305-332`

这形成三个用户可见后果：

- “已掌握词汇”实际包含只看过一次释义的词。
- “翻译缓存有效小时数”同时控制这些词继续显示多久，界面只把它解释为缓存策略。
- 用户手动加入已掌握词汇后，已有内存或持久缓存仍可让它继续显示。

产品需要先定义“看到”“认识”“学习中”“忽略”“已掌握”的用户动作和转换条件。当前状态机缺少可解释的掌握证据。

## P1 详细问题

### UX-004 / UX-005：首次设置给出虚假完成状态，并且缺少恢复

AI 与 Anki 步骤均允许直接继续。最终页只显示“可以开始阅读”，没有汇总连接状态、试译结果或下一步修复入口。证据：

- `src/onboarding/onboarding.html:154-230`
- `src/onboarding/onboarding.html:233-244`
- `src/onboarding/onboarding.ts:101-110`

首次安装只打开一次 onboarding tab，流程没有完成标记、当前步持久化或设置页内的“重新运行引导”。证据：

- `src/background/onboarding.ts:1-13`
- `src/onboarding/onboarding.ts:41-46`

八步流程也只提供单向“继续”。用户无法返回修正上一步，Anki 的可选性也缺少明确表达。推荐把首次价值交付缩短为“说明数据范围 → 配好 AI → 完成一次真实试译”，Anki 和外观进入可跳过的后续任务。

### UX-006：内容外发范围缺少信任设计

扩展申请 `<all_urls>`，在所有 frame 注入 content script；自动翻译会在页面打开后开始扫描。AI 请求包含可见文本所在的句子和 token。证据：

- `manifest.json:12-30`
- `src/content/index.ts:43-74`
- `src/background/ai.ts:38-83`

官网只强调“使用您自己的 AI 服务”和“词汇状态留在浏览器”，首次设置、弹窗和设置页都没有说明哪些页面文本会发送到哪个 endpoint。证据：

- `website/public/index.html:224-241`
- `src/onboarding/onboarding.html:154-198`
- `src/popup/popup.html:18-40`

用户需要在开启前看到：发送字段、目标服务、触发条件、缓存位置、API key 存储位置和当前站点范围。自动翻译还需要逐站允许、排除列表或明确的全局授权。

### UX-007：词表选择语义会产生反向过滤结果

设置只允许从七个词表中单选，缺少“关闭基础词表”或组合选项。证据：

- `src/shared/types.ts:203-208`
- `src/core/lexicon.ts:5-41`
- `src/options/options.html:77-81`

数据实验显示：

- `senior-high` 完整包含 `junior-high`，符合累计层级。
- `cet6` 缺少 `cet4` 中 3492 个词，并缺少十个抽样基础词。
- TOEFL 与 GRE 也缺少十个抽样基础词。

选择 CET-6、TOEFL 或 GRE 后，用户会看到大量基础词，同时这些考试词被当作已知词隐藏。标签需要明确表达集合含义，考试层级需要组合基础集合，用户还需要“全部显示”选项。

### UX-008 / UX-009 / UX-010：设置保存成功与页面结果脱节

content script 只在启动时读取一次设置，之后没有 `chrome.storage.onChanged` 或设置更新消息。外观、快捷键、词表和自动翻译在已打开页面继续使用旧值。证据：

- `src/content/index.ts:43-74`
- `src/options/options.ts:802-843`

释义持久缓存 key 只看句子、token、span 和目标语言；provider、model、prompt 与推理强度均未参与。页面内存缓存还位于持久缓存和词汇状态之前。证据：

- `src/core/cache.ts:5-21`
- `src/background/glossResolver.ts:305-337`

“清空翻译缓存”只调用 `storage.glossCache.clear()`，没有清理 `GlossResolver` 内存缓存。证据：

- `src/background/index.ts:40-43`
- `src/background/glossResolver.ts:107-145`

用户改 prompt、模型、provider、已掌握状态或清缓存后，页面仍可能显示旧结果。设置页需要明确“立即生效 / 下次扫描生效 / 需要重载”的状态；缓存清理应覆盖当前生效层，并提供单词级刷新错误结果的动作。

### UX-011：制卡缺少提交前控制和提交后撤销

一次 Alt+点击会依次执行 AI 生成、Anki 写入、card cache 写入和 carded-word 写入。页面只显示 pending、成功背景或错误背景，最终响应只暴露第一个 note id。证据：

- `src/background/messages.ts:94-140`
- `src/content/index.ts:619-692`
- `src/content/overlay.ts:386-414`

用户无法确认正反面、修正例句、选择创建数量、查看实际牌组或撤销刚创建的 note。自定义 prompt 允许返回多张卡片，页面仍只给一次成功反馈。核心制卡动作需要最小预览和明确提交；成功反馈应包含牌组、数量与撤销窗口。

### UX-012 / UX-013：核心动作与状态缺少等价无障碍路径

选词模式只监听键盘按住状态和鼠标点击坐标，页面词汇没有可聚焦控件、上下文菜单动作或触屏手势。证据：

- `src/content/selection.ts:28-112`
- `src/content/selection.ts:182-225`

成功卡片在已有释义时保留原释义文本，只改变背景色；失败也可保留释义并改变颜色。普通 ready、pending 和成功状态均缺少 `role=status` 或 `aria-live`。错误详情只放在 wrapper 的 title 与 aria-label。证据：

- `src/content/overlay.ts:328-414`
- `src/content/overlay.ts:626-661`

浏览器语义树中，成功的“细致”仍只读作普通文本，状态变化没有语义。产品至少需要键盘可触达的制卡命令、触屏路径、可见图标/文字和辅助技术播报。

### UX-014：弹窗没有真实页面状态

“已准备 / Ready”写死在 HTML，打开任何页面都会出现。按钮始终叫“翻译本页”，成功后直接关闭弹窗；重新打开后仍无法判断翻译是否已经开启，也无法从弹窗关闭。证据：

- `src/popup/popup.html:18-32`
- `src/popup/popup.ts:35-57`

弹窗需要读取当前 tab 的能力与活动状态，覆盖：不可注入、初始化中、可开启、扫描中、已开启、无候选、部分失败和已关闭。

### UX-015：未保存设置缺少离页保护

设置页已经维护 `clean / dirty / saving / error` 状态，但没有离页提醒。实测修改学习窗口后直接刷新，值从 9 恢复为 3。证据：

- `src/options/options.ts:257-317`

保存按钮在桌面端常驻是良好基础；移动端 header 变为普通文档流后，用户在长页面底部更容易忘记保存。可采用 dirty 时离页提示，或把普通字段改成可靠的自动保存。

### UX-016：快捷键配置允许冲突并影响网页输入

捕获器接受纯 modifier 和任意按键，Escape 会被记录成快捷键，Tab 也会被消费；捕获状态缺少取消、超时、清空和重置。两个 Glossa 快捷键之间也没有冲突检查。证据：

- `src/options/options.ts:119-149`
- `src/options/options.ts:731-761`
- `src/shared/shortcut.ts:11-45`

页面监听器在 document capture 阶段工作，未排除 input、textarea、contenteditable 或站点快捷键区域。证据：

- `src/content/index.ts:574-583`
- `src/content/selection.ts:49-111`

默认纯 Alt 还会冻结指针与滚动。快捷键需要冲突校验、编辑区域保护和清晰的取消/恢复默认操作。

### UX-017：AI 连接测试只验证“收到 JSON”

`testAiSettings` 调用请求后直接返回，未验证 Responses、Chat Completions、Completions 或 Glossa Backend 的实际输出结构。证据：

- `src/shared/settingsForm.ts:175-203`
- `src/shared/settingsForm.ts:408-450`

实测本地 mock 给 OpenAI Responses 返回 `{ "items": [] }`，按钮进入 success，状态文本为空。真实工作流随后还会经过 provider 输出解析与 gloss/card schema 验证。测试需要复用真实解析器并验证一条最小结果。

### UX-018：等待过程缺少边界感

默认制卡预算包含两次 30 秒 AI 尝试、一次 30 秒 Anki 写入和 5 秒缓冲，共 95 秒。证据：

- `src/content/cardTimeout.ts:3-18`
- `src/background/ai.ts:173-213`

页面期间只显示 `...`，没有剩余时间、阶段、取消或重试。AI frame 还通过全局串行出口执行，长页面后续请求会继续排队。用户需要看到“正在生成 / 正在写入 Anki / 排队中”，并能取消仍未产生外部写入的阶段。

### UX-019：持久数据缺少完整控制面

扩展持久化 settings、lexicon、glossCache、cardCache 和 cardedWords。设置页只管理 `known` 记录和 glossCache。证据：

- `src/storage/db.ts:39-59`
- `src/options/options.ts:373-485`

用户删除 Anki 中的 note 后，cardedWords 仍会长期触发重复提示；模型变更后的旧 cardCache 也无法清理。需要提供存储说明、分项计数、导出、分项清理和完整重置。

## P2 / P3 证据与修复方向

### UX-020 / UX-021：页面能力和错误恢复

- content script 设置读取失败后只写诊断并停止启动，页面没有可见状态：`src/content/index.ts:43-63`。
- popup 捕获到异常时直接使用 `Error.message`，Chrome 的英文通信错误可能原样显示：`src/popup/popup.ts:169-180`。
- 页面错误以 `×` 和 title 展示，缺少“重试”“打开设置”“检查 Anki”动作：`src/content/overlay.ts:341-374`。
- 全部候选被词表过滤或页面没有候选时，扫描直接结束，用户看不到“本页没有需要显示的词”。

推荐为每次手动启动返回一个用户结果：显示数量、过滤数量、等待数量、失败原因和下一动作。

### UX-022：异步操作失败反馈不完整

- Onboarding 的 `continueOnboarding()` rejection 只会恢复按钮，没有 catch 和状态文案：`src/onboarding/onboarding.ts:48-59`。
- Onboarding 刷新 Anki 失败只把按钮设为 error，`reportStatus` 在 catch 中未使用：`src/onboarding/onboarding.ts:143-164`。
- 词汇刷新、添加、删除和清空以 `void` 启动，缺少局部错误状态：`src/options/options.ts:88-103`、`src/options/options.ts:374-466`。

### UX-023：Anki 设置成本高且入口不足

引导只写“安装 AnkiConnect”，没有安装链接、add-on code、版本检查说明和权限提示：`src/onboarding/onboarding.html:201-230`。设置页加载后立即刷新 Anki catalog，并对每个 model 串行请求字段；拥有很多 note type 的用户会等待较久：`src/options/options.ts:802-838`、`src/shared/settingsForm.ts:251-276`。

推荐把刷新改成显式动作或并行有界动作，显示已检查模型数；引导提供可执行的安装与验证步骤。

### UX-024 / UX-026：词汇管理信息架构

空列表仍渲染 A–Z 26 个“暂无词汇”段落：`src/options/options.ts:403-447`。320px 实测同时出现对话框滚动和列表滚动。添加框位于 form 外，Enter 不触发添加；帮助文本“按 known 状态处理”暴露内部状态名：`src/options/options.html:337-361`。

手动添加只调用 `normalizeLemma`，任意非空字符串均可写入，非拉丁词又被归入 Z：`src/options/options.ts:379-415`。推荐默认只渲染有内容的分组，提供搜索和总数，支持 Enter，验证单词形状，并使用用户语言描述状态。

### UX-025：删除动作缺少保护

清空翻译缓存、清空已掌握词汇和单词移除都直接执行：`src/options/options.ts:84-103`、`src/options/options.ts:451-485`。已掌握词汇属于用户积累数据，适合确认或短时撤销；翻译缓存适合显示条目数和清理后的实际生效范围。

### UX-027：扫描规则缺少用户预期

默认最小长度为 3、每个 lemma 每次扫描最多一次、全大写单词被跳过：`src/content/scanner.ts:105-108`、`src/content/scanner.ts:161-175`、`src/content/scanner.ts:347-360`。这些规则降低噪声，同时会让后续出现的词、Go、AI、CSS 等词汇缺少释义。推荐提供“稀疏 / 标准 / 全部”密度语义，手动选择仍覆盖自动过滤。

### UX-028 / UX-029：页面布局和文本兼容

wrapper 采用 `inline-block`、`max-content`、`white-space: nowrap`，并按标签宽度撑开正文；模型输出的 display 只验证字符串类型，没有长度上限：`src/content/overlay.ts:162-195`、`src/background/ai.ts:304-320`。长释义、窄表格、overflow 容器和站点 `!important` CSS 都可能造成换行、裁切或覆盖。

隐藏宽度探针和标签都是真实文本节点：`src/content/overlay.ts:558-577`。复制、整段朗读和依赖 `textContent` 的站点脚本会看到额外内容。推荐把测量文本移到不可选择的隔离层，并验证复制输出；标签视觉需要最大宽度、截断/展开策略和站点 CSS 隔离测试。

### UX-030：窄屏操作路径

options 的 `html` 与 `body` 都设 `min-width: 320px`，320px 桌面视口因滚动条剩余 305px 可用宽度而产生横向滚动：`assets/options.css:26-34`。移动端 header 取消 sticky，AI/Anki 错误仍写到顶部全局 status：`assets/options.css:886-910`。实测重复确认在 320px 覆盖首段正文。

推荐以可用布局宽度为基准测试 320px，状态消息放到触发控件附近，页面 prompt 避开当前目标词并保留正文上下文。

### UX-031：重复确认的可访问性和时间限制

重复提示使用普通 div 加 `role=dialog`，没有 `aria-modal`、焦点圈闭和倒计时；默认 5 秒后自动取消：`src/content/index.ts:832-966`。屏幕阅读器与动作较慢的用户可能尚未完成阅读，提示已经消失。推荐使用无自动失效的明确确认，或提供可见倒计时和暂停/延长能力。

### UX-032：provider 表单未按能力收敛

所有 provider 共用 API key、模型、推理强度和 endpoint 表单：`src/options/options.html:173-230`。Glossa Backend 请求不使用 API key，legacy Completions 请求不使用 reasoning effort：`src/background/ai.ts:38-83`、`src/background/ai.ts:102-109`。切换 provider 还会立即覆盖 endpoint：`src/options/options.ts:113-117`。

推荐按 provider 显示有效字段，保留每个 provider 的最近 endpoint，并在覆盖自定义地址前给出明确说明。

### UX-033：页面内手动状态范围不透明

SPA URL 变化时，翻译状态重置为 `manualActivation || autoTranslateEnabled`，普通路由变化会恢复自动翻译默认值：`src/content/index.ts:140-152`。弹窗和页面没有显示“本页 / 当前路由 / 当前 tab / 全站”的作用范围。推荐定义并展示状态层级，再让路由行为遵循该模型。

### UX-034：安装承诺省略持续成本

官网写“下载、解压、加载，三步即可开始阅读”：`website/public/index.html:260-280`。实际还包含八步 onboarding、AI 凭据、可选 Anki 配置、开发者模式、全站权限和手动更新。安装页需要展示首次可用所需条件，并说明版本更新与卸载后数据行为。

### UX-035：文案与可配置视觉细节

- popup 混用 `Reader control / 01`、`Ready` 与中文：`src/popup/popup.html:12-24`。
- options 预览和 onboarding 装饰内容使用英文；浏览器语义树观察到 `Reading sample / Glossa` 生成内容：`assets/onboarding.css:232-250`。
- 词汇帮助显示内部词 `known`：`src/options/options.html:349-356`。
- 背景深浅 range 缺少当前数值输出；自定义前景、背景和透明度缺少对比度检查：`src/options/options.html:109-148`。

## 产品承诺差距

| 对外表达 | 当前行为 |
| --- | --- |
| “读取完整句子” | 扫描以文本节点为边界，行内元素会截断或跳过词 |
| “记住已经掌握或忽略的词” | 显示一次即进入 known；ignored 缺少用户入口 |
| “三步即可开始阅读” | 首次可用还依赖八步流程与 AI 配置 |
| “卡片保留当前语境” | 同 lemma 卡片缓存忽略句子与词义，点击上下文还可能混入释义文本 |
| “清空翻译缓存” | 页面内存缓存继续命中，当前页面结果可能保持不变 |
| “当前页面已准备” | 弹窗没有读取页面能力或活动状态 |

## 建议的处理顺序

1. 先定义词汇状态、卡片唯一性、语境边界、数据外发范围和翻译状态作用域。这五项是实现其余修复的产品真源。
2. 修复 UX-001、UX-002、UX-003，并为多义词、DOM 分片、缓存刷新和状态转换建立回归测试。
3. 把 onboarding 收敛为可验证的首次试译，加入隐私说明、恢复状态和可选 Anki 任务。
4. 为制卡加入预览/确认/撤销，补齐键盘与触屏路径，重做可见和辅助技术状态反馈。
5. 让 popup、settings、content 共享实时页面状态和设置变更协议，统一缓存清理语义。
6. 收尾处理错误恢复、词汇管理、Anki catalog 性能、320px 响应式和文案一致性。

## 后续验证门槛

修复进入发布候选后，至少补齐以下真实环境研究：

- 新 Chrome profile 安装、权限提示、扩展固定、升级与卸载。
- 真实 OpenAI-compatible endpoint 的成功、401、404、超时、格式错误与费用感知。
- 真实 AnkiConnect 的安装、很多 note type、无兼容模型、删除外部 note 与撤销。
- Wikipedia、Medium、GitHub、SPA、Shadow DOM、长文、表格、overflow 容器、复杂行内标记和受限页面。
- 纯键盘、屏幕阅读器、200% 缩放、触屏、窄屏与 `prefers-reduced-motion`。
- 1k、10k、50k 文本节点页面上的首次扫描、滚动扫描、mutation 扫描和 AI 排队时间。
