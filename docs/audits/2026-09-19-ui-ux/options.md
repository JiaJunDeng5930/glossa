# Glossa 设置页 UI/UX 审查

审查对象是 [src/options](../../../src/options) 及对应的 `assets/options.css`。我使用仓库已经构建的 `dist/options.js`，在 Playwright 独立 context 中注入了与 `tests/helpers/uiPage.ts` 同语义的 Chrome runtime fixture；没有连接用户真实 Chrome 数据。截图和测量证据位于 `images/options/`。

严重级别：P1 表示核心设置流程无法完成或会造成明显误操作；P2 表示常见流程明显费解、难用或在一个目标尺寸失效；P3 表示局部视觉、文案或低频可用性问题。

## 已确认问题

<a id="o01"></a>

### O01 — P2 — 排版/视觉层级 — 表单控件继承了标签的 720 粗体

- **复现状态**：正常加载设置页，在桌面和 390/320px 视口观察默认值，并进入“提示词”区查看长英文提示词。
- **用户后果**：输入框、下拉框和文本域中的值与字段标题一样粗，中文设置标题、帮助文字、英文提示词都显得拥挤；320px 下长提示词被粗体放大成多行，阅读和扫描成本更高。
- **修正方向**：给 `input/select/textarea` 明确设置常规字重（例如 450/500），仅保留 `label` 标题使用 720；同时保留焦点和错误态的对比度。
- **源码**：[assets/options.css:294-302](../../../assets/options.css)（label 为 `font-weight: 720`），[assets/options.css:356-375](../../../assets/options.css)（控件只 `font: inherit`，未重置字重）。
- **证据**：[desktop-loaded-full.png](images/options/desktop-loaded-full.png)、[mobile-390-bottom-viewport.png](images/options/mobile-390-bottom-viewport.png)；Playwright 测量 `mobile-390-typography`：`inputWeight=720`、`labelWeight=720`、`helpWeight=450`。
- **验证类型**：视觉截图 + computed-style 测量。

<a id="o02"></a>

### O02 — P2 — 响应式/保存 — 320/390px 长页面滚到底部后保存动作不可见

- **复现状态**：在 390px 或 320px 视口加载设置页，滚动到“提示词/缓存”底部。
- **用户后果**：移动端 `workspace-header` 被设为静态，顶部“保存”按钮随页面离开视口；用户编辑最下面的提示词或缓存 TTL 后必须回到页面顶部才能保存，且底部没有保存反馈或替代动作。
- **修正方向**：在窄屏保留紧凑 sticky header，或提供底部 sticky 保存栏；至少让“有未保存更改”状态在当前视口有可达动作。
- **源码**：[assets/options.css:924-948](../../../assets/options.css)，其中 `:max-width:680px` 的 `.workspace-header { position: static; }` 在 933-936 行。
- **证据**：[mobile-390-bottom-viewport.png](images/options/mobile-390-bottom-viewport.png)、[mobile-320-bottom-viewport.png](images/options/mobile-320-bottom-viewport.png)；测量 `mobile-390-save-at-bottom`：`scrollY=4385`、`saveTop=-3962.78`；320px：`scrollY=4532`、`saveTop=-4109.78`。页面总高度分别为 5229px/5376px。
- **验证类型**：Playwright 实际滚动 + 视口截图 + bounding-box 测量。

<a id="o03"></a>

### O03 — P2 — 空状态布局 — 桌面端空词汇状态被压成竖排单字

- **复现状态**：正常加载后点击“管理词汇”，fixture 返回 0 条已掌握词汇。
- **用户后果**：对话框中的“当前没有已掌握词汇。”被渲染在约 44px 的窄列里，中文逐字换行，空状态像布局坏掉，用户很难一眼读懂。
- **修正方向**：当字母索引隐藏时，让 `.known-words-browser` 改为单列，或给空状态单独的 `grid-column: 1 / -1`；空状态应在列表区域水平正常排版。
- **源码**：[assets/options.css:758-764](../../../assets/options.css) 固定了 `44px minmax(0, 1fr)` 两列；[src/options/options.ts:549-554](../../../src/options/options.ts) 在无记录时只隐藏导航并插入空状态。
- **证据**：[known-dialog-empty-dialog.png](images/options/known-dialog-empty-dialog.png)（裁剪后的对话框左下可见逐字竖排），完整页面版本为 [known-dialog-empty.png](images/options/known-dialog-empty.png)。移动端因为 984-986 行的单列 media rule 未复现该问题。
- **验证类型**：桌面 Playwright fixture 空数据 + 视觉截图。

<a id="o04"></a>

### O04 — P2 — 词汇管理信息架构 — 没有搜索入口

- **复现状态**：fixture 返回多条词汇后打开“已掌握词汇”对话框；检查添加区和已存在词汇区。
- **用户后果**：管理区只有逐个输入的“添加”、逐个“移除”和按首字母跳转；词汇较多时无法按文本搜索，只能手动滚动和逐条操作。批量导入属于后续能力扩展，本问题聚焦于当前已有词汇难以查找。
- **修正方向**：添加对现有记录的搜索/过滤输入，并在对话框中保留当前字母索引作为辅助定位；批量导入可以另行设计格式和预览流程。
- **源码**：[src/options/options.html:397-409](../../../src/options/options.html) 只有单词输入、添加、清空、字母索引和列表；[src/options/options.ts:536-615](../../../src/options/options.ts) 只有分组渲染和字母导航，没有过滤/导入状态。
- **证据**：[known-dialog-populated-dialog.png](images/options/known-dialog-populated-dialog.png)（裁剪后的对话框），完整页面版本为 [known-dialog-populated.png](images/options/known-dialog-populated.png)；可见 6 条记录仍只有 A/C/G/N/Z 首字母按钮与逐行“移除”。
- **验证类型**：功能路径检查 + 真实数据 fixture 截图。

<a id="o05"></a>

### O05 — P2 — Anki 可发现性 — 牌组和模板初始禁用，但没有解释为何禁用

- **复现状态**：正常加载默认设置，进入 Anki 区；未点击右侧的刷新图标。
- **用户后果**：`Anki 牌组`、`Anki 卡片模板` 显示为灰色且不可操作，但界面没有说明需要刷新 Anki 目录、连接失败还是尚未保存地址；唯一入口是没有文字的 40px 刷新图标，用户很容易把灰色选择框理解为功能不可用。
- **修正方向**：在禁用选择框附近显示“点击刷新读取 Anki 牌组和模板”，把图标按钮改成带文字的“读取 Anki 选项”或同时保留 aria-label；加载、空目录、错误态分别给出原因。
- **源码**：[src/options/options.html:289-315](../../../src/options/options.html)；[src/options/options.ts:365-393](../../../src/options/options.ts)；图标尺寸见 [assets/options.css:603-607](../../../assets/options.css)。
- **证据**：[desktop-ai-anki.png](images/options/desktop-ai-anki.png)：牌组和模板灰显，刷新按钮只有图标，面板下方没有解释。
- **验证类型**：正常默认状态截图 + DOM/源码路径检查。

<a id="o06"></a>

### O06 — P2 — 错误恢复 — 设置格式错误只显示在顶部，字段旁没有定位反馈

- **复现状态**：正常加载后把“AI 接口地址”改为 `localhost`，再观察错误态和保存动作。
- **用户后果**：页面只在顶部输出“设置格式无效，请修正后再保存”，输入框没有字段级错误说明或 `aria-invalid` 线索。桌面顶部 header 是 sticky，状态仍可见，但用户仍不知道具体是哪一项；移动端顶部 header 是静态的，用户在底部编辑时更难看到全局错误。
- **修正方向**：在字段下方显示具体错误（例如“请输入 http/https 地址”），设置 `aria-invalid`/`aria-describedby` 并在保存失败时滚到第一个错误字段；顶部状态保留为摘要即可。
- **源码**：[src/options/options.ts:220-227](../../../src/options/options.ts) 只设置全局错误状态；接口字段在 [src/options/options.html:241-245](../../../src/options/options.html)，没有字段错误节点。
- **证据**：[desktop-invalid.png](images/options/desktop-invalid.png)、[desktop-invalid-ai.png](images/options/desktop-invalid-ai.png)；测量 `invalid-state`：全局 status 有文本，保存按钮变为“重试保存”，但 `aiEndpoint` 下无错误输出。
- **验证类型**：Playwright 输入非法值 + 保存/测试路径 + 截图和 DOM 检查。

<a id="o07"></a>

### O07 — P2 — 初始化状态 — settings.get 等待/失败时显示空表单，保存按钮仍可点击

- **复现状态**：fixture 延迟 `settings.get`，或让 `settings.get` 返回 error；观察响应到达前及失败后的页面。
- **用户后果**：表单保持 `inert=true`，但视觉上没有 loading 说明，快捷键、接口地址、模型等显示为空，顶部“保存”按钮仍可用；失败态仅在顶部小字显示“设置加载失败，请重新打开页面”，用户可能误以为空设置、点击保存无效或覆盖配置。
- **修正方向**：加载期间显示明确的“正在读取设置…”并禁用保存，保留 skeleton/占位；加载失败时把空表单隐藏或覆盖成错误面板，提供“重试加载”动作。
- **源码**：[src/options/options.ts:45](../../../src/options/options.ts) 设置 inert，`107-108` 只在失败时写错误文字，`257-272` 完成读取后才填表；保存按钮未纳入 inert/加载状态。
- **证据**：[desktop-settings-loading-top.png](images/options/desktop-settings-loading-top.png)、[desktop-settings-load-error-top.png](images/options/desktop-settings-load-error-top.png)；测量 `settings-loading-state`：`inert=true`、`status=""`、`saveDisabled=false`，失败态 `status="设置加载失败，请重新打开页面"`、`saveDisabled=false`。
- **验证类型**：Playwright 延迟/失败 fixture + 状态截图 + DOM 测量。

<a id="o08"></a>

### O08 — P3 — 触控可用性 — 词汇字母索引、移除和重置图标明显偏小

- **复现状态**：在 390px/320px 打开已掌握词汇对话框，或在“提示词”区触碰重置图标。
- **用户后果**：移动端字母索引最小高度 28px，逐行“移除”最小高度 31px，提示词重置图标 34px；这些目标相对 42px 高的主要表单控件明显偏小，在窄屏密集布局中更容易误触，尤其字母按钮本身只显示一个字母。
- **修正方向**：扩大辅助按钮的命中区域到约 44px（视觉图标可保持较小），增加字母按钮行距；图标按钮提供可见文字或扩大 padding。这里是触控可用性建议，不把 44px 作为当前插件的硬性合规门槛。
- **源码**：桌面默认值见 [assets/options.css:603-613](../../../assets/options.css)、`774-783`、`829-836`；移动 media rule 见 984-997，字母按钮高度仅 28px。
- **证据**：[mobile-390-known-dialog-dialog.png](images/options/mobile-390-known-dialog-dialog.png)、[mobile-320-known-dialog-dialog.png](images/options/mobile-320-known-dialog-dialog.png)、[mobile-390-bottom-viewport.png](images/options/mobile-390-bottom-viewport.png)；完整页面版本为 [mobile-390-known-dialog.png](images/options/mobile-390-known-dialog.png)、[mobile-320-known-dialog.png](images/options/mobile-320-known-dialog.png)。Playwright 测量正常表单控件高度 42px，而这些辅助按钮 CSS 高度为 23/28/31/34px。
- **验证类型**：390/320px 截图 + CSS/布局尺寸检查。

<a id="o09"></a>

### O09 — P3 — 文案 — “深浅”与实际控制的背景透明度不一致

- **复现状态**：在“释义样式”区拖动“深浅”滑块，观察数值和帮助文案。
- **用户后果**：字段标题让人以为调整颜色明暗，数值显示百分比，帮助文案却说“背景透明度”；用户无法直接判断 94% 是颜色亮度还是不透明度。
- **修正方向**：将字段标题统一为“背景透明度”，或把帮助文字和单位改成与“深浅”一致。
- **源码**：[src/options/options.html:133-139](../../../src/options/options.html)。
- **证据**：[desktop-appearance.png](images/options/desktop-appearance.png)，可见标题“深浅”、右侧“94%”和帮助文字“背景透明度”同时出现。
- **验证类型**：视觉截图 + 文案与字段语义对照。

<a id="o10"></a>

### O10 — P3 — 桌面布局 — AI/Anki 并排区按最高列撑高，Anki 右下出现明显空白

- **复现状态**：正常加载默认设置，在 1440px 桌面查看“普通 AI / Anki”并排区。
- **用户后果**：两列使用同一 grid 行高，Anki 的“重置制卡记录”之后仍保留一大段空白，右列内容密度明显低于左列；整个设置文档看起来像是右侧内容没有完成，视觉重心偏左。
- **修正方向**：让两块服务设置按各自内容组织，或把 Anki 的危险操作和状态放入更紧凑的独立行；如果必须并排，至少让下方空白有明确的分组/说明用途。
- **源码**：[assets/options.css:233-236](../../../assets/options.css) 定义两列 grid；[src/options/options.html:230-329](../../../src/options/options.html) 将 AI 与 Anki 作为同一 grid 行的两个 panel。
- **证据**：[desktop-ai-anki.png](images/options/desktop-ai-anki.png)、[desktop-loaded-full.png](images/options/desktop-loaded-full.png)；在正常成功加载截图中，Anki 操作按钮结束后仍有约 100px 以上空白直到 panel 底部，而左列继续到更低的 AI 测试区。
- **验证类型**：正常加载桌面截图 + layout 结构检查；这是视觉比例判断，优先级低于功能/可达性问题。

## 覆盖范围与限制

已覆盖正常加载、settings.get 延迟/失败、保存中/保存失败/保存后修改（[desktop-saving.png](images/options/desktop-saving.png)、[desktop-save-error.png](images/options/desktop-save-error.png)）、非法 AI 地址、快捷键冲突、AI/Anki 连接错误（[ai-test-error.png](images/options/ai-test-error.png)、[anki-refresh-error.png](images/options/anki-refresh-error.png)）、空/有数据/词汇添加校验/词汇读取失败、字典 + Jev 条件区、外观实时预览、Anki 默认禁用目录、提示词重置区、缓存操作区，以及桌面 1440px、移动 390px 和 320px。键盘路径实际操作了快捷键捕获与冲突反馈；正常表单控件焦点样式随截图一并检查。正常加载的外观区比例在 1440px 下为约 0.8fr 控件区 + 1.2fr 预览区，预览有意保留大面积留白且在 390/320px 仍能换行展示，因此没有把它单独列为缺陷；AI/Anki 并排区的空白则记录为 O10。

Anki/AI/Jev 的网络测试使用 fixture 响应或失败，不代表真实第三方服务文案；未把 UI preview 自带的 chrome mock 加载失败计为产品问题。未修改产品源码，也未提交代码。
