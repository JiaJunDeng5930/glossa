# Glossa 异步状态模型

本文定义 Glossa 所有会跨事件循环、跨扩展上下文或跨持久化边界的状态。实现以这里的 owner、线性化点和不变量为准；定时器、revision 和 Promise lane 只用于落实这些语义。

## 全局规则

1. 每份可变业务状态只有一个 owner。其他模块通过命令或原子存储操作改变它。
2. 每个异步操作在启动时捕获不可变输入。完成结果只有在操作仍属于当前 epoch 时才能提交。
3. 取消负责阻止后续提交。已经发生的外部副作用进入明确的成功或结果未知状态。
4. UI 状态由业务状态派生。旧 Promise 的完成结果不能覆盖较新的用户输入、路由、设置或操作反馈。
5. IndexedDB 的 readwrite transaction 是词汇状态的线性化点。普通 `get` 后接 `put` 不能表达业务状态转换。
6. 端口消息按单一命令流处理。Chrome 的投递顺序只有在接收端串行执行时才构成协议顺序。

## 状态 owner

| 状态 | Owner | 线性化点 |
| --- | --- | --- |
| 当前 route 的翻译开关 | 顶层 frame 的 content runtime | runtime 命令在 control queue 中提交 |
| 子 frame 的翻译开关 | 子 frame content runtime | 顶层状态同步或显式广播提交 |
| 当前 frame 的扫描 | content runtime | scan epoch 递增 |
| 单个 gloss 端口协议 | service worker 的 port session | 串行命令完成 |
| AI 生成代际和页面内存缓存 | `GlossResolver` | generation epoch 递增 |
| 持久释义缓存清理 | `GlossResolver` | 缓存写入 lane 中的 clear transaction 完成 |
| 单词词汇状态 | IndexedDB lexicon transaction | transaction commit |
| 单词制卡操作 | service worker card coordinator | 单词 lane 中的状态转换 |
| 制卡记录重置 | service worker card coordinator | reset barrier 内的多 store transaction commit |
| 设置页面草稿 | 当前 options/onboarding 页面 | 本地 draft revision 递增 |
| 已保存设置 | `chrome.storage.local` | settings write 完成；并发页面采用最后完成的显式保存 |
| 连接测试、Anki catalog、词汇列表视图 | 发起任务的 UI 控件 | operation revision 匹配当前输入时提交 |

## Content runtime

Content runtime 有三个生命周期状态：

```text
booting -> ready -> stopped
    \--------------> stopped
```

- 模块加载时立即注册轻量 control listener，所以 popup 可以区分 `booting`、`ready` 和真正不可注入的页面。
- `booting` 期间读取设置、加载词表并完成子 frame 状态同步。页面扫描只在这些依赖全部就绪后启动。
- `ready` 持有 `{ routeKey, translationEnabled, autoDefault, settings, knownWords, scanConfigHash }`。route 变化会创建新的 route epoch，并用最新 `autoDefault` 初始化开关。`scanConfigHash` 是 known-word-list id 与生成设置 identity 的不透明哈希，不携带 API key 明文。
- `stopped` 是终态。扩展上下文失效后，监听器、端口、计时器和 DOM 注入全部释放，任何晚到结果都只能被丢弃。

顶层 frame 是 tab 当前 route 开关的权威来源。popup 的 toggle 必须由顶层 frame 基于实时状态原子计算，然后把结果广播给现有子 frame；晚启动子 frame 在首次扫描前向顶层同步。popup 缓存的旧状态只用于渲染，不能用于计算下一状态。

### Content runtime 不变量

- C1：control listener 的可达性不依赖设置读取或词表加载时长。
- C2：同一 frame 的 control 命令按接收顺序提交。
- C3：一个 scan 捕获同一份 route、设置和词表快照；`scan.start` 携带该快照的 `scanConfigHash`，后台只接受与当前已保存设置匹配的 start。
- C4：route 变化、关闭翻译和 stop 会同步退休当前 scan epoch。
- C5：子 frame 在同步完成前不产生自动扫描。

## 页面扫描与结果合并

每个 scan attempt 使用独立状态，替代全局 `scanInProgress`：

```text
scheduled -> collecting -> draining -> awaiting-results -> done
                 |            |              |
                 +----------> retired <-------+
                 \----------> failed
```

- `collecting` 遍历 DOM、建立 token map 并发送 chunk。AI 结果暂存在本 attempt 的 outcome queue，避免扫描过程中修改 DOM。
- DOM 收集结束后进入 `draining`，刷新本 attempt 的 outcome queue，并发送 `scan.end`。
- `awaiting-results` 接收后台结果。`gloss.done` 表示该端口不会再产生 token 结果。
- 新 scan 会把旧 attempt 标记为 `retired`。退休 attempt 的结果只能通过原 token 的 surface、offset、fingerprint 和局部文本上下文校验后更新旧 pending wrapper。
- route、设置代际、关闭翻译和 stop 直接关闭对应端口；普通 DOM mutation 允许旧 pending 结果按上面的校验完成。

卡片反馈与 gloss 结果是同一 token 上的两层状态。`card-pending`、`card-success`、`card-error` 的显示优先级高于 gloss 的 `pending`、`ready`、`hidden`、`error`；gloss 结果可以更新底层释义，不能清除正在进行或刚完成的制卡反馈。

### Scan 不变量

- S1：一个 frame 同时只有一个 active scan attempt；退休 attempt 只保留受校验的结果订阅。
- S2：outcome queue、producer 完成和 terminal 状态全部属于单个 attempt。
- S3：`scan.end` 排在该 attempt 的全部 chunk 之后。
- S4：后台 disconnect 或 protocol error 会让 attempt 进入 `failed`，释放所有 ack waiter，并把仍存在的 pending wrapper 置为错误终态。
- S5：旧 attempt 永远不能创建新 wrapper，只能更新仍与原文本匹配的 pending wrapper。

## Gloss 端口协议

Service worker 为每个 `gloss.session` 端口维护一个串行命令 queue：

```text
awaiting-start -> accepting-chunks -> finishing -> closed
       |                 |               |
       +---------------> failed <--------+
       \---------------> disconnected
```

- `gloss.scan.start` 只能出现一次。
- start 的 `scanConfigHash` 必须匹配后台当前设置。失配表示 content 尚未完成最新设置协调，该 session 以 obsolete 终止，content 重新读取设置后创建新 attempt。
- chunk index 必须从 0 单调递增，chunk id 在端口内唯一。
- `gloss.chunk.ack` 在线性化地接收并登记该 chunk 的 lookup task 后发送。
- `gloss.scan.end` 只能在 start 之后出现一次。串行 queue 保证它看到此前所有 chunk；`finish()` 等待 lookup、AI 结果和需要完成的持久化写入。
- 任一协议错误使端口进入 `failed`。后续消息不会重新开启 session。
- disconnect 只取消该端口的订阅。共享 AI miss 仍可为其他活动订阅者完成。

### Port 不变量

- P1：`done` 发生在所有已 ack chunk 的 terminal token 结果之后。
- P2：每个收到的 chunk 恰好 ack 一次，失败端口会释放所有 content 侧 waiter。
- P3：端口 handler 内不并行执行 start、chunk 和 end。
- P4：后台不会把新设置的 AI 配置与旧设置的 content 词表混成一个 scan。

## 生成代际与缓存

`GlossResolver` 持有 `{ generationEpoch, generationIdentity, clearBarrier }`。

设置变化时，`generationIdentity` 变化会同步递增 epoch、清空页面内存缓存并取消旧 AI frame。持久缓存键已经包含 generation identity，所以设置变化无需清空整库；旧 identity 的条目无法命中新设置，切回旧设置时仍可复用原结果。

用户执行“清空翻译缓存”时，resolver 同步递增 epoch、取消旧 frame、清空内存，再把 persistent clear 排到统一缓存写入 lane。新 session 捕获新 epoch，并等待 `clearBarrier` 后读取缓存。退休 epoch 已经排队或正在执行的缓存写入先完成，clear 随后完成，所以清空成功后旧工作无法重新填充缓存。

旧格式、缺少 `createdAt` 的缓存条目直接按过期处理。运行时不再异步回填旧条目，避免回填跨过 clear 的线性化点。

### Cache 不变量

- G1：session 只向与自身 epoch 相同的 sink 发结果。
- G2：设置 identity 隔离依靠 cache key；全库 clear 只响应用户的显式清理动作。
- G3：clear 完成后，clear 之前启动的工作无法写回内存或持久缓存。
- G4：相同 identity 的重复激活不创建新 epoch。

## 词汇状态

每个 `lang:lemma` 的转换都在一个 IndexedDB readwrite transaction 内读取当前记录、计算下一状态并提交：

```text
missing -> candidate -> known
              |           |
              +-> learning_active --到期--> known
known --------+
任意可管理状态 -> ignored
```

- 成功展示释义执行 `markShown`。`candidate` 进入 `known`；`learning_active` 保持学习状态并增加展示计数。
- Anki 成功创建卡片后执行 `markCardCreated`，记录进入 `learning_active` 并延长学习窗口。
- 到期转换在一次原子读取中完成。
- 手动添加执行 `markKnown`。手动移除只删除 transaction 线性化时仍处于 `known` 的记录。
- 手动移除与清空已掌握词汇时，carded marker 与 lexicon 删除在同一多 store transaction 中提交。
- 制卡成功时，carded marker、note id 合并和 `learning_active` 转换在同一多 store transaction 中提交。

### Vocabulary 不变量

- V1：任何旧读取都不能通过后续 `put` 覆盖较新的 clicked、shown、ignored 或 note id 状态。
- V2：`markShown` 永远不把 `learning_active` 或 `ignored` 降级为 `known`。
- V3：成功制卡的 note id、duplicate marker 和学习状态同时可见。
- V4：清空已掌握词汇不会删除并发时已经转为 `learning_active` 的记录。

## 制卡

页面的一次点击只有一个紧凑徽标和一个 terminal 结果，所以制卡契约收敛为“一次点击创建一张 Anki 卡片”。AI 返回空数组或多张卡片都属于无效响应，避免部分成功无法由现有 UI 准确表达。

每个单词使用一个 service worker lane：

```text
received -> duplicate-check -> generating -> adding-note -> recording-local -> succeeded
    |             |               |             |
    +----------> duplicate        +----------> failed-before-commit
                                  \----------> outcome-unknown
```

- 同一页面 occurrence 已有 pending 操作时，重复点击复用现有 pending 状态，不再排第二个完整操作。
- duplicate-check 在线性化的单词 lane 内执行。用户确认重复后产生一条新的明确制卡命令。
- AI 生成发生在外部写入之前；AI 网络失败可以安全重试。
- `addNote` 收到有效 note id 后，外部副作用已经提交。随后本地历史写入失败仍向页面报告卡片创建成功，并记录诊断；用户目标已经完成。
- Anki HTTP 明确错误或 AnkiConnect error 是 `failed-before-commit`。请求超时、网络断开或成功响应无法解析属于 `outcome-unknown`，因为服务端可能已经创建卡片；页面继续显示 `×`，title/aria-label 明确提示检查 Anki 后再重试。
- card content cache 是生成优化。缓存写入失败不改变制卡 terminal 结果。

重置制卡记录使用全局 barrier：重置命令先阻挡后来的制卡，等待此前所有制卡进入 terminal 状态，再用一个多 store transaction 清理历史，最后释放后来的制卡。

重复确认 prompt 独立使用 `open -> confirmed | cancelled | timed-out | superseded`。同一 document 同时只有一个 open prompt，按钮、Escape、计时器、新 prompt 和关闭翻译都调用同一个幂等 finish；finish 只解析一次 Promise，并统一清理 timer、DOM、监听器与焦点。

### Card 不变量

- A1：一次用户命令最多发起一次 Anki `addNote`。
- A2：同一单词的 duplicate-check 与 addNote 按 lane 顺序执行。
- A3：外部提交成功决定用户可见成功；缓存和本地记录属于后续持久化。
- A4：客户端超时不能把仍在后台排队的操作伪装成确定失败；同 occurrence 的重复点击不会增加排队时间。
- A5：reset 的线性化点把“重置前操作”和“重置后操作”完整分开。

## 设置、引导和弹窗任务

Options 与 onboarding 在设置读取完成前使用原生 `inert` 锁住表单。读取成功后才进入 ready；读取失败保持错误状态，旧快照不会覆盖用户输入。

Options 的 draft revision 每次输入递增。保存捕获 `{ snapshot, submittedRevision }`；完成时 revision 相同则进入 clean，revision 已变化则保持 dirty。多个设置页面采用显式保存的最后完成写入，页面之间不做自动合并。

连接测试和 Anki catalog 都捕获 connection key 与 operation revision。完成时只有 key 和 revision 同时匹配当前表单才可更新按钮、状态和 select。开始新的同类操作会退休旧操作。

词汇对话框的 add、remove、clear 和 refresh 走一个 UI operation lane，交互期间禁用同组 mutation 控件；每次 mutation 完成后再读取并渲染列表。底层数据正确性仍由 IndexedDB transaction 保证。

Popup 使用 `loading -> ready(enabled|disabled) -> toggling -> unavailable`。按钮在 loading 与 toggling 时禁用；toggle 由顶层 frame 根据实时状态计算。快捷键提示读取失败时使用默认值，不覆盖页面能力状态。

### UI task 不变量

- U1：初始设置读取完成前，用户无法编辑或提交将被旧快照覆盖的表单。
- U2：旧 connection test、catalog refresh 和词汇 refresh 结果不能覆盖当前输入或较新的操作。
- U3：每个 destructive control 同时只有一个活动任务。
- U4：popup 的按钮文案、enabled 状态和下一次 toggle 都来自同一个顶层 frame 状态。

## 传输、计时器与 service worker 生命周期

- Gloss AI 和制卡内容 AI 都发生在外部持久副作用之前。网络与 timeout 可以最多重试一次；generation 退休会通过 AbortSignal 终止 gloss 请求。
- Connection test 只读外部状态，completion 受 operation revision 约束。旧任务可以继续消耗传输资源，但没有提交业务状态的权限。
- Anki `addNote` 不做自动重试。发送请求后的网络、timeout 和响应解析故障使用 `outcome-unknown`。
- 普通 settings read、catalog read 和 cache clear 的客户端 timeout 只终止等待，不代表远端命令被取消；相关 UI completion 仍由 operation revision 防止晚结果覆盖当前状态。
- Card runtime watchdog 到期只产生 `outcome-unknown`，不能产生确定失败。后台 AI 与 Anki transport 自身负责有限完成时间。
- scan debounce、AI frame timer、duplicate prompt timer 和 navigation `requestAnimationFrame` 都只是 owner 的触发器。owner 退休时必须清理 timer；timer callback 再次检查 owner epoch 后才能执行 effect。
- 正常 runtime message 与 port 会让 service worker 在事件处理期间保持活动。意外重启会断开 port，使 scan 进入 failed；制卡若已发送 `addNote` 则进入 outcome-unknown。所有已提交的词汇、缓存与制卡历史仍以 IndexedDB transaction 为准。

## 异步边界覆盖

| 模块 | 异步来源 | 归属模型 |
| --- | --- | --- |
| `background/index.ts` | storage change、runtime message、port message | generation、cache、port protocol |
| `background/glossResolver.ts` | DB coalescing、AI frame timer、AI queue、cache/lexicon writes | scan session、generation、cache、vocabulary |
| `background/messages.ts` | frame state relay、word lanes、reset barrier、AI/Anki | content control、card、vocabulary |
| `background/ai.ts` | fetch、retry、timeout、AbortSignal | transport、generation、card |
| `background/anki.ts` | addNote fetch 与 timeout | card external commit |
| `storage/db.ts` | chrome.storage、IndexedDB request/transaction | settings commit、cache、vocabulary |
| `content/index.ts` | boot、settings change、route、scan、port、card response、runtime message | content runtime、scan、card |
| `content/scanner.ts` | chunk callback yield | scan attempt |
| `content/overlay.ts` | mutation suppression timer、晚到 gloss/card 结果 | scan merge、render priority |
| `content/selection.ts` | async selection callback | card operation；快捷键本身是同步状态机 |
| `core/lexicon.ts` | word-list fetch | content boot 与 settings task revision |
| `core/cache.ts`、`shared/hash.ts` | WebCrypto Promise | 不可变 operation input，无共享状态 |
| `shared/settingsForm.ts` | connection fetch、catalog sequence、timeout | UI task revision、transport |
| `options/options.ts` | initial load、save、test、catalog、cache/reset、known words | settings draft、UI tasks、vocabulary |
| `onboarding/onboarding.ts` | initial load、step save、test、catalog | settings draft、UI tasks |
| `popup/popup.ts` | tab query、content control、settings hint | popup、content control |
| `background/onboarding.ts` | install event、tab create | 单次 fire-and-forget，无共享可变业务状态 |

## 当前实现违例与实施顺序

| 顺序 | 现状 | 违背不变量 | 处理方向 |
| --- | --- | --- | --- |
| 1 | background port 为每条消息启动独立 async IIFE，end 可以早于 chunk 登记 task | P1、P3 | 建立端口串行命令状态机 |
| 2 | content 用全局 `scanInProgress` 管理所有 session 的 outcome queue | S1、S2 | 把 producer 与 queue 状态移入单个 attempt |
| 3 | port disconnect 只释放 ack，没有关闭 attempt 或终结 pending wrapper | S4、P2 | disconnect 进入 terminal failure |
| 4 | generation identity 变化会清空整库，并与 scan start 共享异步 clear 屏障 | G2 | 用 key 隔离设置，保留 clear 给显式用户动作 |
| 5 | clear 与 AI cache write、旧缓存回填可以互相越过 | G3 | 统一缓存写入 lane，移除旧条目回填 |
| 6 | lexicon 多处使用 `get` 后 `put/delete` | V1、V3、V4 | 改为原子 transaction 状态转换 |
| 7 | hidden gloss outcome 可以移除正在显示制卡反馈的 wrapper | S5、A4 | 固定 card feedback 的显示优先级 |
| 8 | 一次 AI 响应允许多卡和空卡，partial success 最终显示单个错误徽标 | A1、A3 | 收敛为一次点击一张卡 |
| 9 | 同一 occurrence 可重复排队，客户端 timeout 不包含 lane 等待 | A4 | content 复用 pending 操作 |
| 10 | Anki 传输错误统一显示确定失败 | A3 | 区分明确失败与 outcome unknown |
| 11 | options/onboarding 在异步初始读取期间允许交互 | U1 | ready 前设置 form inert |
| 12 | Anki catalog 完成结果未绑定当前 endpoint/revision | U2 | catalog task 加 key 与 revision gate |
| 13 | 词汇列表读取与增删清可并行完成并互相覆盖 UI | U2、U3 | 单一 UI operation lane |
| 14 | content control listener 在完整 boot 后才注册，popup 用固定六秒猜测启动完成 | C1 | 提前注册并返回显式 lifecycle phase |
| 15 | popup 根据缓存状态计算 desired state，并从全 frame 广播中接收非确定 frame 的响应 | C2、U4 | 顶层 frame 原子 toggle，再广播结果 |
| 16 | content 与 background 在 scan start 两侧独立读取设置，可能组合旧词表与新生成配置 | C3、P4 | start 携带并校验 `scanConfigHash` |
| 17 | settings change 可以并行运行多个 reconcile，scan 没有统一的依赖快照提交点 | C3 | desired settings 立即更新，异步依赖按 revision 提交，scan 只读取完整快照 |
| 18 | `scheduleScan` 的异步失败缺少统一 terminal 处理，start 发送失败会留下已登记 session | C4、S4 | 统一 effect error path 与 session cleanup |

实施按表中依赖顺序进行。端口、scan attempt、cache epoch 和原子词汇转换先建立稳定底座；制卡与 UI task 随后只调用这些 owner，不再建立第二套 revision、flag 或补偿路径。

## 验证矩阵

时序测试使用可控 deferred Promise 和显式事件顺序，不依赖真实延时碰撞。

| 场景 | 必须证明的结果 |
| --- | --- |
| start、两个 chunk、end 在 settings read 完成前连续到达 | 后台仍按 start → chunk 0 → chunk 1 → end 执行，done 最后出现 |
| 新 scan 在旧 scan 收集 DOM 时启动 | 两个 attempt 各自刷新队列；旧结果只能更新匹配的 pending wrapper |
| port 在 pending 与 ack 之间断开 | 所有 waiter 释放，pending wrapper 进入错误终态，扫描 Promise 完成 |
| 设置从 A 快速变为 B 再变为 C | 只有 C 的词表和生成配置能创建 active scan；A/B completion 无提交权限 |
| settings identity 变化后旧 AI 返回 | 旧结果不进入当前页面内存，也不向当前 sink 发出 |
| manual cache clear 与 cache put、旧条目读取并发 | clear 返回后所有 store 与内存都为空，旧任务无法回填 |
| 同一 lemma 的 shown 与 card success 以两种顺序提交 | 最终计数完整，learning_active 不丢失，note id 与 marker 一致 |
| clear-known 与 card success 并发 | transaction 顺序决定 known 删除或 learning 保留，不出现 stale put 复活旧记录 |
| gloss hidden 在 card pending/success 后到达 | 制卡徽标保持；底层 gloss 状态可在反馈结束后恢复 |
| 同一 occurrence 连续点击两次 | 只发出一个后台制卡命令和一个 addNote |
| AI 返回 0 张或 2 张卡 | addNote 不执行，页面进入明确错误终态 |
| addNote timeout、网络断开、200 后无效 JSON | 页面进入 outcome-unknown，后台不自动重试 addNote |
| addNote 返回 note id 后本地记录写入失败 | 页面仍报告成功，并产生本地持久化诊断 |
| reset 与前后两个制卡操作交错 | 前操作完成后清理，后操作只在清理完成后启动 |
| options/onboarding 的 settings read 被延迟 | 表单保持 inert，用户输入不会被晚到快照覆盖 |
| Anki catalog A 延迟，用户改为 endpoint B 并刷新 | A completion 不改变 B 的 select 与状态 |
| 词汇 refresh、add、remove、clear 快速触发 | UI 按 lane 顺序显示最终存储快照，无旧 refresh 回写 |
| popup 初始化后页面被快捷键切换，再点击 popup | 顶层 frame 原子 toggle 当前实时状态，所有 frame 收到同一结果 |
