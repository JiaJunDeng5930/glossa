# Glossa 入口 UI/UX 审查：onboarding 与 popup

审查日期：2026-09-19。范围是 `src/onboarding` 的八步首次设置、LLM/dictionary 分支、返回/跳过/连接失败，以及 `src/popup` 的可用、已开启、不可用、重试、切换失败和 malformed response 状态。没有修改源码。

## 问题

<a id="e01"></a>

### E01 · P2 · onboarding / 进度反馈

**触发体验**：从第 1 步连续点击「继续」到第 8 步，文字计数会从 `1 / 8` 变化到 `8 / 8`，但底部红色进度线始终只有约 1/8 长度。

**后果**：同一页面同时显示“8 / 8”和“仍在 1/8 位置”的视觉信号，用户无法用进度线判断剩余步骤；首次设置的完成感和导航方向被破坏。

**建议**：让 CSS `:has()` 使用实际的命名 step 值（`smart`、`translation`、`anki-click`、`word-list`、`appearance`、`ai`、`anki`、`finish`），或由 `showStep()` 统一写入进度变量。不要继续维护一套与 step identity 不同的数字值。

**源码**：[assets/onboarding.css:64](../../../assets/onboarding.css)–[assets/onboarding.css:71](../../../assets/onboarding.css) 选择 `data-step="0"` 到 `"7"`；实际身份见 [src/onboarding/onboarding.html:18](../../../src/onboarding/onboarding.html)、[src/onboarding/onboarding.html:40](../../../src/onboarding/onboarding.html) 及后续命名值。

**证据**：Playwright 在 1280×900 逐步读取 CSS，8 个状态的 `--step-progress` 全部为 `0.125`、`::after` transform 全部为 `matrix(0.125, 0, 0, 1, 0, 0)`。截图：[8/8 完成页](images/entry/desktop-08-finish.png)、[1440px 完成页](images/entry/desktop-1440-finish.png)、[320px 完成页](images/entry/mobile-320-08-finish.png)。

**验证类型**：已实测 + 静态确认。

<a id="e02"></a>

### E02 · P2 · onboarding / 翻页后焦点丢失

**触发体验**：在任意已加载步骤点击「继续」或「返回」。

**后果**：新步骤出现后，键盘焦点落到 `BODY`，而不是新步骤标题或第一个可操作控件。当前实测仍可继续 Tab 到可操作控件，但键盘用户必须重新猜测页面位置；读屏用户也不会得到新步骤标题的上下文，八步流程的导航语义被削弱。

**建议**：切换步骤时先解除新步骤的 `inert` 再 focus 标题，或在 `setNavigationBusy(false)` 后重新 focus；保留可见的焦点样式，并让进度/步骤变化由可访问名称播报。

**源码**：[src/onboarding/onboarding.ts:126](../../../src/onboarding/onboarding.ts)–[src/onboarding/onboarding.ts:133](../../../src/onboarding/onboarding.ts) 在异步导航期间保持 `navigationBusy`；[src/onboarding/onboarding.ts:172](../../../src/onboarding/onboarding.ts)–[src/onboarding/onboarding.ts:187](../../../src/onboarding/onboarding.ts) 的 `showStep()` 在 busy 时把当前步骤设为 inert，随后对 inert 标题执行 `focus()`。

**证据**：Playwright 实测初始步骤 `activeElement=H1`，第 2 至第 8 步均为 `BODY`；鼠标流程仍可完成。步骤截图：[第 2 步](images/entry/desktop-02-translation.png)、[第 6 步](images/entry/desktop-06-ai-llm.png)、[第 7 步](images/entry/desktop-07-anki.png)。

**验证类型**：已实测 + 静态确认。

<a id="e03"></a>

### E03 · P3 · onboarding / 标题出现浏览器默认蓝色焦点框

**触发体验**：首次打开 onboarding，或修复 E02 后把焦点真正移到新步骤的 `h1`。

**后果**：标题周围出现 Chrome 默认蓝色 1px outline，与 Glossa 的米白、赭红和细线视觉体系不一致，看起来像浏览器选中了标题或表单发生了错误；在窄屏标题周围尤其突兀。

**建议**：为被用作焦点落点的标题定义与设计系统一致的 `:focus-visible` 样式（或采用不显示焦点框的无障碍 live region，把可见焦点交给第一个控件），不要依赖 UA 默认蓝框。

**源码**：[src/onboarding/onboarding.ts:183](../../../src/onboarding/onboarding.ts)–[src/onboarding/onboarding.ts:186](../../../src/onboarding/onboarding.ts) 将 `h1` 设为 `tabIndex=-1` 并 focus；[assets/onboarding.css:176](../../../assets/onboarding.css)–[assets/onboarding.css:184](../../../assets/onboarding.css) 没有标题焦点规则，现有焦点规则只覆盖 input/select/button。

**证据**：1280×900、1440×900 和 320px 截图中首步标题均有蓝框；computed style 为 `rgb(0, 95, 204) auto 1px`。截图：[1280 首步](images/entry/desktop-01-smart.png)、[320 首步](images/entry/mobile-320-smart.png)。

**验证类型**：已实测 + 主观视觉。

<a id="e04"></a>

### E04 · P3 · onboarding / 小高度视口底部导航不可见

**触发体验**：在 390×420 或更矮的窗口进入外观、AI、Anki 等长表单步骤。

**后果**：首屏只看到表单上半部分，底部「返回 / 继续」被内容推到折叠线以下；滚动后控件仍然可达，但页面没有 sticky 导航或滚动提示，第一次使用者需要自行发现并滚动到页面底部。

**建议**：在小高度视口为 footer 提供 sticky/固定但不遮挡内容的操作区，或在表单较长时给出明确的滚动提示并保持主要导航容易找到；同时检查键盘焦点滚动位置。

**源码**：[assets/onboarding.css:596](../../../assets/onboarding.css)–[assets/onboarding.css:680](../../../assets/onboarding.css) 在窄屏把表单改为单列并保留大段垂直间距；footer 仍是普通文档流元素，见 [assets/onboarding.css:503](../../../assets/onboarding.css)–[assets/onboarding.css:527](../../../assets/onboarding.css)。

**证据**：390×420 初始视口截图只显示标题和颜色控件上半部，底部不在视口：[390×420 viewport](images/entry/mobile-390-short-appearance-viewport.png)；同一状态 full-page 截图显示 footer 在页面底部：[完整外观页](images/entry/mobile-390-short-appearance.png)。320×420 实测 `document.documentElement.scrollHeight=1174`。

**验证类型**：已实测 + 主观视觉。

<a id="e05"></a>

### E05 · P2 · onboarding / 后台加载期间没有可见状态

**触发体验**：首次设置页的 `settings.get` 尚未返回，或 service worker 启动较慢。

**后果**：页面展示完整的第一步和看起来可用的「继续」按钮，但整个 form 仍 `inert`；按钮没有 disabled/loading 外观，状态区为空。用户点击没有反应，也不知道应该等待、刷新还是重新打开页面。

**建议**：加载设置时显示明确的「正在加载设置…」并禁用/标记导航；超时后给出「重新打开」或重试动作，避免把 inert 当作无反馈的隐形状态。

**源码**：[src/onboarding/onboarding.ts:31](../../../src/onboarding/onboarding.ts) 先将 form 设为 inert；[src/onboarding/onboarding.ts:69](../../../src/onboarding/onboarding.ts)–[src/onboarding/onboarding.ts:78](../../../src/onboarding/onboarding.ts) 直到加载完成才设置状态，成功路径见 [src/onboarding/onboarding.ts:246](../../../src/onboarding/onboarding.ts)–[src/onboarding/onboarding.ts:259](../../../src/onboarding/onboarding.ts)。

**证据**：将 `settings.get` 延迟 300ms 的隔离 fixture 实测为 `formInert=true`、`continueDisabled=false`、`status=""`；截图：[加载中](images/entry/loading-settings.png)。

**验证类型**：已实测。

<a id="e06"></a>

### E06 · P3 · onboarding / Anki 安装链接使用浏览器默认蓝色

**触发体验**：进入 Anki 步骤。

**后果**：安装链接呈现为浏览器默认亮蓝色下划线，和页面的赭红强调色、纸张背景及编辑风格明显脱节；在窄屏的长标题下尤其抢眼。

**建议**：给 onboarding 内链/外链统一使用 `--accent`、细下划线和与现有 focus 样式一致的 hover/focus 状态；保留可识别的链接语义。

**源码**：链接在 [src/onboarding/onboarding.html:229](../../../src/onboarding/onboarding.html)，onboarding 样式没有对应的 anchor 规则。

**证据**：截图：[1440px Anki 页](images/entry/desktop-1440-anki.png)、[320px Anki 页](images/entry/mobile-320-07-anki.png)。

**验证类型**：已实测 + 主观视觉。

## 文案边界观察（不计为缺陷）

dictionary-jev 分支只强制验证 Jev，但 Jev 本身就是当前翻译链路中的 AI 服务；完成页的「AI 已连接。Anki 可随时在设置中配置。」在这个语义下不能直接判定为错误。若产品希望把普通 AI 回退或 Anki 制卡所需的普通模型也表达为“已就绪”，建议把完成文案改成「当前翻译方式已连接」，或分别说明普通 AI 回退与 Anki 是否已配置。本次证据只支持“Jev/当前翻译模式连接成功”，不支持普通 AI 或 Anki 已就绪的断言。

## Popup 覆盖结论

在约 360px CSS 视口实测了可用且关闭、已开启、不可用、探测重试、切换超时和 malformed response。可用页的主按钮会根据状态切换为「翻译本页 / 停止翻译」，不可用页会禁用主按钮并给出「当前页面不支持扩展翻译」，错误后按钮恢复可用，状态输出可读且不会把 `Receiving end` 泄露给用户。截图位于 `images/entry/popup/`，包括 `available-off-*`、`available-on-*`、[unavailable-before.png](images/entry/unavailable-before.png)、[retrying-before.png](images/entry/retrying-before.png)、`toggle-error-*` 和 `malformed-response-*`。

真实扩展 profile 也打开了 `chrome-extension://…/popup/popup.html` 页面，实测布局 body 宽度为 300px、高度约 429px，logo 和 CSS 资源正常；真实扩展页截图见 [real-extension-popup.png](images/entry/real-extension-popup.png)。这是真实 extension-origin page 的页面验证，不是 Chrome 工具栏弹出的 action popup，因此没有把工具栏 popup 的自动关闭行为当作已验证事实。由于测试 harness 把 popup 页面作为普通扩展 tab 打开，active-tab 查询落到了不支持的扩展页，真实页状态显示「此页面不可用」；因此 popup 的可用/失败状态以 `tests/helpers/uiPage.ts` 的 Chrome transport mock 实测为准，真实页结果只用于资源、尺寸和布局验证。

## 覆盖与限制

- onboarding：1280×900 和 1440×900 的八步；320px 全部八步；390×420 外观短视口；LLM 与 dictionary-jev 分支；返回、跳过 Anki、未测试 AI、未连接 Anki、设置加载延迟；真实扩展 onboarding 入口截图。
- popup：360×600 mock 视口的正常、开启、不可用、重试、超时、malformed response；真实扩展页布局截图。
- Playwright 使用隔离页面和隔离 extension profile，不读取或写入用户真实设置；仓库源码未修改。
- 未覆盖官网、完整 options 页面和网页 overlay；popup 的真实 toolbar 自动关闭行为未在当前 headless harness 中判定。
