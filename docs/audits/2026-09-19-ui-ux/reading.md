# Glossa 网页内容 UI/UX 审查

审查范围：`src/content` 的 inline gloss、选择模式、重复制卡确认和制卡反馈。未修改产品源码、未连接真实 AI/Anki。生产 UI 预览由 `node scripts/serve-ui-preview.mjs --port 4273` 提供；截图均在 Playwright Chromium 中实际渲染，并用 `view_image` 查看。稳定态截图等待了动画结束；测量值来自浏览器 `getBoundingClientRect()`。`dense-*`、`links-*`、`selection-dark-*`、[card-feedback.png](images/reading/card-feedback.png) 和 [duplicate-underlying-click.png](images/reading/duplicate-underlying-click.png) 是额外构造的宿主页面。

## 已确认问题

<a id="r01"></a>

### R01 — P2 — 选择提示与重复制卡确认框互相覆盖

分类：布局 / 状态组合 / 移动端。

复现：在存在已制过卡的单词上按住 `Alt`，点击单词后继续保持 `Alt`，让后台重复卡响应延迟到达；`selection.ts` 的 hold 状态仍为 active 时，`cardOperations.ts` 会打开 duplicate prompt。稳定态生产预览也直接构造了同一组合：选择提示和重复制卡框同时出现。

证据：

- [desktop-stable.png](images/reading/desktop-stable.png)、[mobile390-stable.png](images/reading/mobile390-stable.png)、[mobile320-stable.png](images/reading/mobile320-stable.png)。390px 时选择提示矩形为 `x=250.8..372,y=18..61.2`，确认框为 `x=20..370,y=20..92.2`；两者相交约 119px 宽，遮住确认框右侧按钮。320px 时提示为 `x=180.8..302,y=18..61.2`，确认框为 `x=12..308,y=12..108.6`，遮住首行文案和按钮行上缘。
- [src/content/overlay.ts:71-94](../../../src/content/overlay.ts) 将选择提示固定在 `top:18px; right:18px`；[src/content/duplicateCardPrompt.ts:17-32](../../../src/content/duplicateCardPrompt.ts) 将确认框固定在 `top:20px; right:20px`，两者没有避让关系。
- [src/content/selection.ts:37-50](../../../src/content/selection.ts) 只有按键释放才退出选择模式；[src/content/cardOperations.ts:55-65](../../../src/content/cardOperations.ts) 在选择回调中等待重复卡响应并弹框，没有释放选择模式。

用户后果：在常见窄屏上「继续制卡」和「取消」的文字会被另一个浮层盖住。由于提示 `pointer-events:none`，部分坐标点击仍可能命中下面的按钮，但用户无法可靠判断当前按钮含义。

修正方向：为页面浮层统一分配纵向堆叠位置，或在打开 duplicate prompt 时临时隐藏/下移 selection note；应把该组合纳入真实延迟响应的视觉回归。

证据类型：生产预览实际截图 + 浏览器矩形测量；状态组合由源码路径证明可达。

<a id="r02"></a>

### R02 — P2 — 声明为 modal 的重复制卡框仍可操作背后的网页

分类：交互 / 焦点与模态语义。

复现：打开重复制卡确认框后，点击框外正文中的按钮。

证据：[duplicate-underlying-click.png](images/reading/duplicate-underlying-click.png)；实际点击框外 `Underlying action` 后，浏览器测量 `behindClicks=1` 且 `document.activeElement.id="behind"`，确认框仍存在。实现 [src/content/duplicateCardPrompt.ts:11-13](../../../src/content/duplicateCardPrompt.ts) 设置 `role=dialog`、`aria-modal=true`，但 [src/content/duplicateCardPrompt.ts:14-32](../../../src/content/duplicateCardPrompt.ts) 只创建固定小框，没有全屏 backdrop/inert；[src/content/duplicateCardPrompt.ts:116-133](../../../src/content/duplicateCardPrompt.ts) 只循环 Tab 和处理 Escape，没有阻止框外点击或焦点移出。

用户后果：用户可以在“是否继续制卡”的决定完成前触发页面其他动作；屏幕阅读器会按 modal 语义认为背景不可操作，实际 DOM 行为却相反，焦点也会离开确认框。

修正方向：要么把它定义为非 modal 的通知并移除 `aria-modal`，要么增加 backdrop/背景 inert 和框外焦点回收；保留 Escape、Tab 循环和返回原焦点。

证据类型：源码静态检查 + Chromium 实际点击和截图。

<a id="r03"></a>

### R03 — P2 — 已有释义时制卡反馈只变颜色，成功/失败/未知缺少明确可见状态

分类：状态反馈 / 信息可辨识性。

复现：先显示一个 ready gloss，再对同一 token 分别应用制卡成功、失败、结果未知反馈。

证据：[card-feedback.png](images/reading/card-feedback.png)。实测 DOM 状态分别是 `data-glossaFeedback=card-success/card-error/card-unknown`，但三个标签的可见文字仍为 `归档/不可用/不确定`，`data-glossa-display-kind` 均为 `gloss`，没有 `✓/×/?` 图标。只有绿色、红色、赭色文字/边框和 `title`/`aria-label`（例如 `archive：制卡完成`）表达状态。实现 [src/content/overlay.ts:300-322](../../../src/content/overlay.ts) 在 gloss ready 时保留原 display；[src/content/overlay.ts:195-223](../../../src/content/overlay.ts) 只对 `data-glossa-display-kind="feedback"` 的 card-error 绘制圆形叉号。

用户后果：读者看到的是一枚颜色改变的释义标签，容易把颜色理解为释义样式或选中态；失败与结果未知尤其不能仅靠视觉文字区分，仅用触屏时也无法依赖 hover title。

修正方向：保留释义的同时增加稳定的状态图标/角标或文字（成功勾、失败叉、未知问号），并保持颜色作为辅助信息；让“制卡完成/失败/未知”在无 hover 时可见。

证据类型：自构造宿主页面的实际截图 + DOM 属性测量。

<a id="r04"></a>

### R04 — P3 — 链接中的 gloss 把宿主链接的下划线颜色改成 vermillion

分类：宿主样式协调 / 链接语义。

复现：在具有蓝色链接和 2px 蓝色下划线的正文中显示 inline gloss。

证据：[links-desktop.png](images/reading/links-desktop.png)：链接文字仍是宿主蓝色，但被 gloss 的单词下划线变成 vermillion，未被 gloss 的同一链接词仍是蓝色下划线，形成一条链接内两种下划线颜色。实现 [src/content/overlay.ts:228-235](../../../src/content/overlay.ts) 对所有 source surface 强制 `text-decoration: underline` 和 `text-decoration-color: color-mix(... accent ...)`。

用户后果：常见链接正文会出现“蓝字 + 红线”的混合视觉，像拼写错误或另一个交互状态；同一链接内不同单词的下划线语义不一致。

修正方向：保留 gloss 目标提示时改用不改变宿主链接 decoration 的标记（例如 outline/background 或仅对非链接文本使用 accent underline），或读取/继承链接的 decoration color。

证据类型：自构造链接宿主的实际截图；是否符合最终产品视觉方向仍需设计确认，故列为 P3。

<a id="r05"></a>

### R05 — P3 — 长释义在移动端永久截断，未提供展开路径

分类：内容可读性 / 窄屏。

复现：让 AI 返回明显长于一行的中文释义，在 390px 和 320px viewport 查看标签。

证据：[long-label390.png](images/reading/long-label390.png)、[long-label320.png](images/reading/long-label320.png)。标签稳定宽度 120px，`clientWidth=118` 而 `scrollWidth=309`；可见文本被 ellipsis 截成“一种非常复杂且最…”，完整内容只在 `title`/`aria-label` 中。实现 [src/content/overlay.ts:137-156](../../../src/content/overlay.ts) 设置 `max-width:min(10em,40vw)`、`overflow:hidden`、`text-overflow:ellipsis`，且 [src/content/overlay.ts:157](../../../src/content/overlay.ts) 让标签不可接收指针事件。

用户后果：常见触屏交互没有 hover，用户无法从页面上的标签取得完整释义；需要重新触发或借助辅助技术才能看到被截断内容。

修正方向：保持紧凑默认态，但允许点击/长按目标词展开完整释义，或提供可访问的移动端 tooltip/popover；截断应保留明确的可发现展开入口。

证据类型：自构造宿主实际截图 + DOM 宽度测量；紧凑标签本身是设计意图，因此此条按 P3 记录为可用性缺口而非布局错误。

## 已检查且未判为问题的范围

- 生产 preview 在 1440、390、320px 均无页面级横向滚动；320px 的 duplicate prompt 自身会切成文案一行、按钮一行，按钮宽度测量正常。
- 高密度 19 个 gloss 的 320px 页面实际截图为 7 行 source、每行上方一行 label；额外高度来自明确的标签空间（无标注同一正文约 167px，密集标注约 363px），未把必要的释义空间单独计为缺陷。
- 深色宿主中默认浅黄标签与白色正文对比清晰，选择遮罩只增加 8% vermillion wash；但选择提示会遮住宿主固定顶部导航的右侧控件（见 [selection-dark390.png](images/reading/selection-dark390.png)、[selection-dark320.png](images/reading/selection-dark320.png)），这属于 R01 同类“固定浮层未避让宿主/其他浮层”的证据，不另拆成重复报告。
- 触屏预览中的 duplicate prompt 按钮实测高度为 36px（`duplicateCardPrompt.ts:72-91`）；这可作为移动端触摸目标改进建议，但当前产品主场景是桌面 Chrome，且没有足够证据把常见 44px 建议判作独立缺陷。
- 未连接真实 Anki/AI；制卡状态使用受控响应和生产 overlay renderer 构造。未检查官网、options、onboarding、popup。

## 验证记录

运行了现有内容相关的 3 个 E2E：`marks card failures with the shared badge renderer` 通过，`asks before creating another card for a carded word` 通过；`lays out inline glosses without label or source overlap` 在 `tests/e2e/content-overlay.spec.ts:1975` 失败，实际收到 18px 而非 `<1`。失败 trace 的最终截图 [page@...4366.jpeg](images/reading/page@2d4063950bb87bacc653e3634c178897-1789833744366.jpeg) 显示两个 gloss/source 与 label 没有重叠，第二个 gloss source 在第一行、后续未标注 archive 因自然换行在下一行；因此把它记录为现有断言与换行数据不一致，未把它升级成视觉缺陷。未修改源码或测试。
