# Glossa 官网 UI/UX 审查

审查日期：2026-09-19（Asia/Shanghai）
范围：`website/public/index.html`、`website/public/styles/global.css`，以及官网在 Chromium 中的实际渲染。插件 popup/options/onboarding/content UI 不在本报告范围内。

## 环境与覆盖

- 本地来源：`http://127.0.0.1:4276/`，由当前 checkout 的 `website/public` 提供。
- 真实浏览器：Playwright Chromium，device scale factor 1。
- 视口：1440×1000、1280×720、1081×700、1024×768、390×844、320×700；另测 1440×1000 的 `prefers-reduced-motion: reduce`。
- 操作：首屏、整页和 story/details/install 各区段截图；滚动 story 进度 0/0.1/0.2/0.3/0.5/0.65/0.75/0.84/0.95/1；检查导航锚点、Tab 焦点、跳到正文、外链属性、图片 alt、标题层级、资源加载和浏览器错误。
- 本地加载结果：HTTP 资源无 4xx/5xx，页面无 `pageerror` 或 console error，当前源码在 1440/1280/1081/1024/390/320 视口的 `document.scrollWidth` 均等于视口宽度。
- 线上尝试：`https://glossaai.pages.dev` 通过本地 `curl` 无法解析域名，web 工具返回不可访问。因此不能确认线上部署版本与本地源码一致；下列结论只代表当前本地源码版本。

截图目录：`images/website/`。其中 [probe.json](images/website/probe.json) 保存测量和交互结果，关键截图见各问题条目。

## 问题清单

<a id="w01"></a>

### W01 · P2 · 320px 固定导航把 GitHub 链接裁掉，键盘焦点也落在可视区外

- 分类：可用性 / 无障碍 / 响应式。
- 触发：在 Chromium 以 320×700 打开官网。头部第二行的 `.site-nav` 可视宽 197px、内容宽 232px；GitHub 链接的实际矩形为 `x=196.30..244.09`，导航可视右边界为 `214.19`，因此截图中只看见 `Git`。继续按 Tab 聚焦 GitHub 时，`navScrollLeft=0`，焦点矩形仍在可视区外，无法看见当前焦点或点击该项。
- 用户后果：最窄且文档承诺支持的 320px 设备上，用户无法完整识别或触摸 GitHub 链接；键盘用户无法看到当前聚焦项。隐藏滚动条也没有给出可发现的“还有内容”提示。
- 修正方向：让导航和下载按钮采用不重叠的布局（例如在 320px 让导航独占一行、下载按钮另起一行，或折叠为菜单）；若保留横向滚动，保证聚焦时自动滚动到可视区并显示可发现的滚动提示。
- 源码：[website/public/styles/global.css:1544-1583](../../../website/public/styles/global.css)（窄屏两行网格、导航 `overflow-x:auto`、隐藏滚动条）；导航内容在 [website/public/index.html:23-28](../../../website/public/index.html)。
- 证据：[mobile-320-top.png](images/website/mobile-320-top.png)；测量与操作证据写入 [probe.json](images/website/probe.json) 外加上述 Chromium 记录。
- 验证类型：真实浏览器测量 + 截图 + 键盘操作。

<a id="w02"></a>

### W02 · P2 · 多处小号元信息的文本对比度明显不足

- 分类：无障碍 / 视觉。
- 触发：查看首屏的 `hero-meta`、预览文章的 Field Notes/6 min read、story 与 install 的 eyebrow。当前使用 `--muted-light` 或约 0.48/0.56 alpha 的浅色文字；这些都是小号、全大写或辅助信息，实际阅读需要依赖低对比度文字。
- 用户后果：低视力用户、低亮度屏幕或环境光较强时，辅助说明与章节上下文难以辨认；页面大标题和按钮清晰，但同一视觉层中的元信息像被“洗掉”，削弱层级和可读性。
- 测量：按 CSS 颜色和实心背景计算相对亮度对比度：`#96978e` on `#f2efe7` 为 `2.57:1`（hero meta），`#96978e` on `#f8f5ed` 为 `2.71:1`（文章 metadata），`rgba(23,24,20,.48)` on `#ddd6ca` 为 `2.94:1`（story eyebrow），`rgba(250,248,241,.56)` on `#a83c21` 为 `2.91:1`（install eyebrow）。这些小号文本低于普通正文常用的 4.5:1 AA 门槛。
- 修正方向：保留暖灰色调但提高辅助文字不透明度/明度差；把纯装饰性的 eyebrow 与真正需要阅读的 metadata 分开处理，必要时提高字号或使用更深的 token。
- 源码：[website/public/styles/global.css:183-212](../../../website/public/styles/global.css)（eyebrow 颜色）、`:317-324`（hero-meta）、`:425-434`（文章 metadata）、`:1043-1045`（story eyebrow）、`:1223-1230`（install 正文及其上下文）。
- 证据：[desktop-1440-top-settled.png](images/website/desktop-1440-top-settled.png)、[desktop-1440-story.png](images/website/desktop-1440-story.png)、[desktop-1440-install.png](images/website/desktop-1440-install.png)；颜色测量记录在本次审查命令输出中。
- 验证类型：真实浏览器计算样式 + 颜色对比度测量 + 截图。

<a id="w03"></a>

### W03 · P3 · 首屏中文文案出现“显示中文义”的缺词

- 分类：功能沟通 / 内容。
- 触发：阅读首屏副标题：“启动 Glossa，生词上方显示中文义。”
- 用户后果：“中文义”不是页面其他位置使用的标准表达，像是“中文释义”被截掉一个字；这会降低产品介绍的可信度，也与页面标题、meta description 中的“中文释义”不一致。
- 修正方向：改为“显示中文释义”，并在发布前对首屏、meta description、story、安装区的同一术语做一次文案一致性检查。
- 源码：[website/public/index.html:47-49](../../../website/public/index.html)；对照同文件 `:9` 的“中文释义”。
- 证据：[desktop-1440-top-settled.png](images/website/desktop-1440-top-settled.png) 可见该句首屏文案。
- 验证类型：真实浏览器截图 + 源码文案对照。

<a id="w04"></a>

### W04 · P3 · 页脚 GitHub 链接的实际点击/触摸目标只有 55×13px

- 分类：无障碍 / 可用性。
- 触发：滚动到 320px 页脚或使用 Tab 聚焦页脚 GitHub。
- 用户后果：链接可见文字只有约 11.2px 高，实际矩形为 `55.28×13px`，触摸和精确鼠标操作困难；它也是整页最后一个外部入口，却没有足够的垂直点击区域。
- 修正方向：给页脚链接增加至少约 24px 的垂直 padding/最小高度，同时保持视觉文字尺寸不变；检查 footer 在窄屏纵向布局中的间距。
- 源码：[website/public/styles/global.css:1313-1327](../../../website/public/styles/global.css)，页脚链接标记在 [website/public/index.html:284-287](../../../website/public/index.html)。
- 证据：[mobile-320-footer.png](images/website/mobile-320-footer.png)；Chromium 320px 测量：`rect={x:127.73,y:6837.91,width:55.28,height:13}`。
- 验证类型：真实浏览器测量 + 截图。

<a id="w05"></a>

### W05 · P3 · reduced-motion 桌面模式把“连续演示”变成章节与制卡卡片同时出现的静态拼接

- 分类：主观视觉与叙事判断 / 减少动态效果偏好。
- 触发：桌面 1440×1000，系统设置 `prefers-reduced-motion: reduce` 后打开页面并滚到 story。脚本会调用 `setStaticStory()`，移除 `.is-interactive`；基础两列布局仍保留三个章节纵向排列，同时 browser frame 内的 Anki 卡片直接以 `opacity:1` 显示。
- 用户后果：用户同时看到“打开文章”“生词上方显示释义”“存入 Anki”三个步骤和已经完成的制卡卡片，步骤关系不再清楚；静态首屏中卡片落在浏览器右下、完整内容需要继续滚动才能看完，和左侧的第 01/02 章形成互相竞争的叙事焦点。这不是容器裁切，而是静态布局的叙事问题。
- 修正方向：为 reduced-motion 单独设计静态终态（例如明确显示三个步骤的静态排版，并把卡片放到文章之后的正常文档流），或让 card 只在最后一段静态内容中显示；不要只把动画变量一次性设为最终值。
- 源码：[website/public/index.html:308-327](../../../website/public/index.html)（静态模式）以及 `website/public/styles/global.css:597-708,848-860,948-1005`（基础章节/卡片布局和 interactive 覆盖）。
- 证据：[reduced-1440-story.png](images/website/reduced-1440-story.png)。
- 验证类型：真实浏览器 reduced-motion 渲染 + 截图。

<a id="w06"></a>

### W06 · P3 · 1081px 交互演示断点的章节 eyebrow 被拆成不均匀的两行

- 分类：视觉 / 响应式。
- 触发：在恰好 1081×700 打开页面并滚到 story。此宽度满足脚本的桌面交互条件（`min-width:1081px`），但左栏宽度只有约 321px；`01 / Reading Flow` 与 `Three quiet moves` 两个 span 都在内部换行，前者断成 “01 / Reading”/“Flow”，后者断成 “Three quiet”/“moves”。
- 用户后果：章节标签的两组信息失去同一基线，分隔线位于两行文字中间；它只在断点附近出现，所以从 1024 的静态版跳到 1081 的动态版时会有明显的排版跳变，视觉上像标题被挤坏。
- 修正方向：为 eyebrow 的每个 span 设置不换行并为断点预留宽度，或把 story 进入交互模式的最小宽度提高到能够容纳标签的值；也可以在窄桌面改用更短的标签文案。
- 源码：[website/public/styles/global.css:183-207,1363-1366](../../../website/public/styles/global.css)（eyebrow 未限制内部换行、1180px 以下 story 两列宽度）；交互阈值在 [website/public/index.html:293-294](../../../website/public/index.html)。
- 证据：[threshold-1081-story.png](images/website/threshold-1081-story.png)；Chromium 测量中 `.story-copy > .eyebrow` 为 `320.86×28.25px`，两个子 span 均高 `28.25px`，而计算行高为 `14.144px`。
- 验证类型：真实浏览器断点截图 + 几何/计算样式测量。

<a id="w07"></a>

### W07 · P3 · reduced-motion 首屏仍保留最长 1.24 秒的释义标签延迟

- 分类：无障碍偏好 / 动效。
- 触发：在 1440×1000 开启 `prefers-reduced-motion: reduce`，加载页面后约 220ms 查看 hero 预览。四个 `hero-gloss` 的中文标签仍因各自的 700/880/1060/1240ms delay 而不可见；只有底部英文下划线先出现，约 1.8 秒后标签才全部出现。
- 用户后果：选择减少动效的用户仍需要等待一个与内容理解有关的 staggered reveal；在慢设备或读者快速扫过首屏时，首屏演示像缺失释义，和“减少动效应立即呈现内容”的预期不一致。
- 修正方向：在 reduced-motion 媒体条件下将这些标签的 `animation-delay` 设为 0，并直接显示最终状态；保留正常模式的逐个出现效果即可。
- 源码：标签延迟在 [website/public/index.html:82-99](../../../website/public/index.html) 的 inline `--gloss-delay`，动画在 [website/public/styles/global.css:536-538](../../../website/public/styles/global.css)；当前 reduced-motion 规则 `:1757-1769` 只缩短 duration，没有清除 delay。
- 证据：[reduced-1440-top.png](images/website/reduced-1440-top.png)（220ms 时无中文标签）与 [desktop-1440-top-settled.png](images/website/desktop-1440-top-settled.png)（等待 1.8s 后可见）。
- 验证类型：真实浏览器 reduced-motion 渲染 + 定时截图。

## 主观视觉判断（不单独计入缺陷）

- 页面明确选择了暖纸色、低饱和灰和大量留白的 editorial 风格；在 1440px 首屏，主要内容集中在中下部，习惯产品型首屏的用户可能会觉得信息密度偏低。这是视觉方向选择，只有在转化率或品牌目标要求更直接时才需要调整。
- story 的 360svh 滚动演示在整页截图中会留下很长的空背景，这是 sticky 演示的结果；真实滚动时内容按进度出现，因此未将整页截图的留白单独计为问题。
- 安装区的大号“文”水印、网格和强朱红背景形成很强的视觉断点，可能显得比前两区更像海报；它与当前 DESIGN.md 的朱红主动作语言一致，暂按风格偏好记录，不作为缺陷。

## 已核对但未列为问题

- 1440/1280/1081 桌面和 1024/390/320 窄屏无横向滚动溢出；story 在 1081×700 以上才进入滚动演示，1024×768 及移动端改为静态文档流，当前断点行为稳定。
- `#story`、`#details`、`#install` 的鼠标锚点在实测中会避开固定头部（`scroll-margin-top` 生效）；截图脚本中为了检查区段而直接滚到 section 几何顶部的截图不用于判定锚点遮挡问题。
- 所有图片都有 alt（鼠标指针为装饰性空 alt/aria-hidden），标题层级为 H1→H2/H3，没有运行时错误或静态资源错误。
- 外部 GitHub/Release 链接均使用 `target="_blank"` 与 `rel="noreferrer"`，CTA 保持指向 `releases/latest`；浏览器审查没有点击外链，外部链路只做了只读 HTTP/API 检查。
- CTA 安装链路已做只读外部核验：`https://github.com/JiaJunDeng5930/glossa/releases/latest` 返回 302 并落到 `v0.2.0`，GitHub API 的 latest release 提供 `glossa-extension-v0.2.0.zip`；ZIP 内含 `manifest.json`（`manifest_version: 3`）。官网安装区 `index.html:264,275-279` 已明确写出下载、解压、打开 `chrome://extensions`、开启开发者模式和“加载已解压的扩展程序”，因此当前未把 CTA/首装衔接列为问题。
