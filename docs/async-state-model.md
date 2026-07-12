# Glossa 交互与异步状态模型

本文定义 Glossa 会改变用户可见行为、协议权限、外部副作用或持久化结果的控制状态，也纳入快捷键这类同步交互状态。实现以这里的 owner、线性化点和不变量为准；定时器、revision 和 Promise lane 只用于落实这些语义。

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

## 形式语义与最小化规则

每个 owner 先把原始回调排入自己的串行队列，再执行 Mealy reducer：

```text
T(controlState, normalizedEvent, data) -> { controlState, data, effects }
```

浏览器所谓“同时发生”只表示回调尚未排序，不构成额外状态。队列按接收顺序逐个线性化；reducer 先原子提交新 state/data，再启动 effect，effect 的完成只能重新投递事件。Promise、timer、port 和 storage callback 不能在队列外直接提交业务状态。

`epoch`、`operationId`、`nextChunkIndex`、`draftRevision`、当前 key 和计数器属于关联数据，不是控制状态。它们只负责把无限输入归一化为有限事件，例如 `RESULT_CURRENT`/`RESULT_STALE`。不能把一个会改变用户可见输出或副作用权限的阶段藏进 boolean flag；那仍然是状态，只是更难检查。

本模型的互斥、穷尽和最小化采用以下判据：

1. **互斥：**每个原始输入只能命中一个归一化事件，谓词按下面的明确优先级求值，不允许多个 handler 各自判断。
2. **穷尽：**每台机器对状态集与归一化事件集的笛卡尔积都有且只有一个转移；无动作也必须明确为 `ignore` 或 `pass-through`。
3. **可判定：**所有 guard 只使用当前队列中可读取的有限字段、集合成员关系、相等比较和有限数值比较，不等待未来事实，也不依赖“用户大概想做什么”。
4. **行为等价：**如果两个状态面对任意后续事件序列时，用户观察、持久化副作用、外部副作用和协议输出都相同，它们必须合并。`done`、`failed`、`disconnected` 等只在进入时输出不同 effect，进入后统一为 `closed`。

完整的 17 台机器和全部转移单元由 [`scripts/check-async-state-model.mjs`](../scripts/check-async-state-model.mjs) 定义。检查器先对 13 组 guard 的有限输入域执行真值表，确认每组原始输入恰好命中一个归一化事件；再展开所有默认自环，验证每个 `(state, event)` 恰好有一个目标、所有目标已声明、所有状态可达，并用分区细化查找仍可合并的行为等价状态。它验证设计本身，不代表当前实现已经符合设计。

### 事件归一化

| 事件分区 | 判定规则 |
| --- | --- |
| current / stale | `completion.operationId === owner.currentOperationId` 为 current，否则为 stale；owner 已关闭时统一投递到 `closed` 自环。 |
| same / new | 规范化后的输入 key 与 owner 的 desired key 全等为 same，否则为 new。 |
| port message | 未知 type 或 envelope 无效为 `MESSAGE_INVALID`。已识别 start 的 payload 无效为 `START_INVALID`；有效且 `scanConfigHash !== currentHash` 为 `START_OBSOLETE`；其余为 `START_VALID`。 |
| port chunk | 已识别 chunk 中，`scanId` 相同、`index === nextChunkIndex` 且 `chunkId` 未登记时为 `CHUNK_VALID`；这个合取式的逻辑否定为 `CHUNK_INVALID`。 |
| scan retire | DOM mutation 或被新 scan 取代为 soft；route 变化、生成设置变化、关闭翻译、stop 为 hard。来源集合固定且不重叠。 |
| cache completion | `clearOperationId` 相同为 current，否则为 stale；generation epoch 变化不改变正在执行的 clear id。 |
| cache put | 写入任务在 cache lane 即将执行 transaction 时重新比较 captured epoch；相同为 current，否则为 stale。 |
| lexicon expiry | 仅当 `expiresAt` 是有限值且 `now < expiresAt` 时为 future；缺失、无效或 `now >= expiresAt` 统一为 due-or-invalid。 |
| Anki failure | 收到明确 HTTP 非成功或 AnkiConnect error 为 definite；`addNote` 已发送后的 timeout、网络断开、响应解析失败或 worker 中止为 outcome-unknown。 |
| save completion | current completion 中 `draftRevision === submittedRevision` 为 unchanged，否则为 changed；非 current 统一 stale。 |
| reset request | `activeCardCount === 0` 为 idle，否则为 busy。 |
| card completion | 完成前 `activeCardCount === 0` 为 accounting-invalid，`=== 1` 为 last，`> 1` 为 more；先归一化，再在转移中递减。 |
| shortcut keydown | 先判断 translation shortcut；命中后按 `event.repeat` 分 first/repeat。未命中再判断 selection hold，最后才是 other。两个规范化 shortcut 相同的设置无效；若旧数据仍冲突，translation 优先。 |
| shortcut capture | 新 chord 与另一个已配置 shortcut 规范化后相同为 conflict，否则为 valid；conflict 不提交，继续等待输入。 |

这些谓词都是二值条件或按顺序排除后的有限分类，所以不会出现两条转移同时成立，也不会留下“其他情况”。

## 最小控制状态

| Owner / 机器 | 保留的控制状态 | 被合并或移出的状态 |
| --- | --- | --- |
| Content runtime | `booting`、`enabled`、`disabled`、`closed` | `ready` 必须拆成 on/off，因为文案、扫描权限和 toggle 结果不同；`stopped` 与其他终态合并为 `closed`。 |
| 依赖加载任务 | `stable`、`loading`、`closed` | 词表 same request 无需重载，new request 退休旧 operation；revision 是数据。 |
| Latest UI task | `idle`、`pending`、`closed` | 连接测试和 catalog 的每次显式 start 都退休旧 operation，即使输入 key 相同；这与依赖加载行为不同，不能共用一张转移表。 |
| 快捷键协调器 | `idle`、`held`、`closed` | 不增加“组合键”状态；第二个 keydown 当场退出 held，再按 translation-first 规则决定是否触发翻译。 |
| Scan attempt | `collecting`、`active`、`retired`、`closed` | debounce 的 `scheduled` 属于调度器；flush/end 是转移 effect；done/failed/disconnected 合并为 `closed`。 |
| Token 制卡反馈 | `gloss`、`card-pending`、`card-success`、`card-error`、`card-unknown`、`closed` | gloss 状态作为 underlay 数据；制卡反馈期间的 gloss 更新不能清除徽标。 |
| Gloss port | `waiting`、`open`、`finishing`、`closed` | finishing 期间仍输出 lookup outcome 并响应 disconnect，与 closed 不等价；done/failed/disconnected 输出 effect 后合并为 `closed`。 |
| Generation/cache | `ready`、`clearing`、`closed` | generation identity 与 epoch 是数据；没有单独的 stale 状态。 |
| Vocabulary record | `missing`、`known`、`learning`、`ignored` | `candidate` 与 `missing` 对所有用户关心的行为等价，而且没有独立持久路径，所以合并为 `missing`。 |
| Card operation | `checking`、`generating`、`adding`、`recording`、`closed` | 各类 terminal 结果是进入 `closed` 时的不同 effect；四个 pending 阶段因外部提交权限不同，不能合并。 |
| Card reset barrier | `open`、`draining`、`resetting`、`closed` | active count 与排队集合是数据；draining 和 resetting 对完成事件的处理不同，不能合并。 |
| Duplicate prompt | `closed`、`open` | confirmed/cancelled/timed-out/superseded 都是关闭时的 effect，不保留终态。 |
| Settings document | `loading`、`ready`、`failed`、`closed` | failed 仍显示可重试错误，和不可见的 closed 不等价。 |
| Settings save | `clean`、`dirty`、`saving`、`error`、`closed` | “保存期间又编辑”由 revision 把完成事件归一化为 unchanged/changed，不增加 saving-dirty 状态。 |
| 排他 UI task | `idle`、`pending`、`closed` | known-word mutation、onboarding step save 共用；pending 时重复 start 明确忽略。 |
| Shortcut capture | `idle`、`capturing`、`closed` | 正在捕获哪个字段和当前 chord 是数据；modifier 与完整组合键共用 capturing。 |
| Popup | `loading`、`on`、`off`、`toggling`、`unavailable`、`closed` | on/off 的可见文案和下一状态不同，不能藏在 ready flag 中；快捷键 hint 是独立数据。 |

### 关键转移

完整矩阵由检查器逐格定义，下面列出会改变控制状态的路径；未列出的同类事件按完整矩阵执行显式自环或进入协议错误，不能自行增加分支。

**Content runtime：**`booting + BOOT_READY_ON/OFF -> enabled/disabled`，失败或 stop 进入 `closed`。`enabled/disabled + SET_*|TOGGLE` 原子计算新状态并广播；route 变化先 hard-retire 旧 scan，再按最新 auto default 进入 on/off。设置需要新词表时启动依赖加载任务，词表 current completion 提交完整 snapshot 后才允许扫描。

**快捷键：**`idle + KEYDOWN_HOLD -> held`。`held + KEYDOWN_OTHER -> idle` 且原事件原样通过，所以 Alt+Tab 等页面或系统组合键仍按原语义处理；`KEYDOWN_TRANSLATE_FIRST` 无论从 idle 还是 held 都只触发一次翻译，repeat 只消费而不重复 toggle。hold release、失焦、shortcut 变化和 detach 都从 held 退出。这里不需要“长按计时”状态：modifier keydown 到 keyup 之间就是 held。

**Scan 与 port：**collecting 期间的 outcome 只进入 attempt 自己的 queue；DOM 完成后以一个 effect flush 并发送 end，然后进入 active。普通 DOM 变化使其进入 retired，结果只能更新仍通过 fingerprint 校验的旧 pending wrapper；hard retire、后台 done 或任何 terminal error 都进入 closed。Port 只允许 `waiting + START_VALID -> open`、`open + CHUNK_VALID -> open` 和 `open + END -> finishing`；finishing 继续输出已登记 lookup 的结果，随后按 `FINISH_OK/ERROR` 进入 closed。任何状态下的其他协议次序都有唯一的错误或忽略结果。ACK waiter 由 map 管理，不是控制状态。

**Cache：**identity 改变只递增 generation epoch、取消旧 frame 并清内存，状态仍是 ready。显式 clear 进入 clearing，所有 put 与 clear 共用一个写 lane；新 session 等待 barrier。current clear completion无论成功失败都回到 ready并显示对应结果，stale completion 永远忽略。缺少 `createdAt` 的旧缓存直接按过期处理，不异步回填。

**Vocabulary：**所有事件都在单个 IndexedDB readwrite transaction 内执行。`SHOWN` 将 missing 变为 known，对 known/learning 只增加计数，对 ignored 无效；`CARD_CREATED` 从任意状态进入 learning，表示用户明确制卡可以覆盖 ignored；learning 只有有效未来 expiry 才保持，否则确定转为 known；`REMOVE_KNOWN` 只把线性化时仍为 known 的记录变成 missing。

**Card：**checking 只产生 duplicate prompt 或进入 generating；AI 必须恰好返回一张卡才进入 adding。`addNote` 前的失败是 failed-before-commit，发送后的不确定传输故障是 outcome-unknown，获得 note id 后进入 recording，此后本地写入失败仍输出用户成功。所有结果输出后统一 closed。同 occurrence 在 card-pending 时复用原操作，不建立第二条 lane。

**Reset 与 prompt：**reset 在没有 active card 时直接 resetting，有 active card 时先 draining；每个 card completion 先按 active count 归一化并递减，最后一个 completion 触发 clear，计数为零却收到 completion 则关闭 barrier 并报告内部错误。新 card 一律排在 barrier 后，clear 完成后统一释放。Prompt 只有 open/closed，按钮、Escape、timeout、新 prompt 和 owner close 都调用同一个幂等 finish；新 prompt 会先以 no 结束旧 prompt，再保持 open 显示新内容。

**Settings 与 popup：**settings document 在 load 完成前保持原生 inert；保存捕获 snapshot 与 revision，current completion 再按 unchanged/changed 进入 clean/dirty。Latest task 每次显式 start 都替换旧 operation，但只提交 current result；排他任务 pending 时忽略重复 start。Shortcut capture 只有 idle/capturing，目标字段和 chord 是数据；与另一快捷键冲突时留在 capturing，用字段旁的一行短错误提示继续等待，不增加确认页或说明文字。Popup 的 CLICK 只请求顶层 frame 基于实时状态 toggle，完成结果返回 on/off；loading、toggling 和 unavailable 时按钮不可触发第二次操作。

### 不变量

- C1：control listener 在 booting 前注册；一个 scan 只捕获一份 route、设置、词表和 `scanConfigHash` 快照。
- S1：一个 frame 只有一个 current attempt；retired attempt 不能创建 wrapper，hard-retired attempt 不能再提交结果。
- P1：端口命令串行执行，`done` 位于所有已 ack chunk 的 terminal outcome 之后，每个合法 chunk 恰好 ack 一次。
- G1：相同 generation identity 不创建新 epoch；显式 clear 返回后，clear 前工作不能重新写回缓存。
- V1：shown、card、expiry、ignored 和手动管理都通过一个 lexicon transaction 线性化，旧读取不能覆盖新状态。
- A1：一次用户命令最多调用一次 `addNote`；外部 note id 决定用户成功，本地记录不反转成功。
- U1：旧异步结果不能覆盖当前输入； destructive control 同时只允许一个 owner task；popup 文案与 toggle 都来自同一个顶层状态。

## 传输、计时器与 service worker 生命周期

- Gloss AI 和制卡内容 AI 都发生在外部持久副作用之前。网络与 timeout 可以最多重试一次；generation 退休会通过 AbortSignal 终止 gloss 请求。
- Connection test 只读外部状态，completion 受 operation revision 约束。旧任务可以继续消耗传输资源，但没有提交业务状态的权限。
- Anki `addNote` 不做自动重试。发送请求后的网络、timeout 和响应解析故障使用 `outcome-unknown`。
- 普通 settings read、catalog read 和 cache clear 的客户端 timeout 只终止等待，不代表远端命令被取消；相关 UI completion 仍由 operation revision 防止晚结果覆盖当前状态。
- Card runtime watchdog 到期只产生 `outcome-unknown`，不能产生确定失败。后台 AI 与 Anki transport 自身负责有限完成时间。
- scan debounce、AI frame timer、duplicate prompt timer 和 navigation `requestAnimationFrame` 都只是 owner 的触发器。owner 退休时必须清理 timer；timer callback 再次检查 owner epoch 后才能执行 effect。
- 正常 runtime message 与 port 会让 service worker 在事件处理期间保持活动。意外重启会断开 port，使 scan 以错误 effect 进入 `closed`；制卡若已发送 `addNote` 则输出 outcome-unknown 后进入 `closed`。所有已提交的词汇、缓存与制卡历史仍以 IndexedDB transaction 为准。

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
| `content/selection.ts` | shortcut、page input、async selection callback | shortcut coordinator、card operation |
| `core/lexicon.ts` | word-list fetch | content boot 与 settings task revision |
| `core/cache.ts`、`shared/hash.ts` | WebCrypto Promise | 不可变 operation input，无共享状态 |
| `shared/settingsForm.ts` | connection fetch、catalog sequence、timeout | UI task revision、transport |
| `options/options.ts` | initial load、save、test、catalog、cache/reset、known words | settings draft、UI tasks、vocabulary |
| `onboarding/onboarding.ts` | initial load、step save、test、catalog | settings draft、UI tasks |
| `popup/popup.ts` | tab query、content control、settings hint | popup、content control |
| `background/onboarding.ts` | install event、tab create | 单次 fire-and-forget，无共享可变业务状态 |

## 当前实现违例与实施顺序

| 顺序 | 现状 | 对应约束 | 处理方向 |
| --- | --- | --- | --- |
| 1 | background port 为每条消息启动独立 async IIFE，end 可以早于 chunk 登记 task | port 命令必须串行 | 建立端口串行命令状态机 |
| 2 | content 用全局 `scanInProgress` 管理所有 session 的 outcome queue | attempt 状态必须隔离 | 把 producer 与 queue 状态移入单个 attempt |
| 3 | port disconnect 只释放 ack，没有关闭 attempt 或终结 pending wrapper | terminal 必须收敛到 closed | disconnect 输出错误后关闭 attempt |
| 4 | generation identity 变化会清空整库，并与 scan start 共享异步 clear 屏障 | identity 由 key 隔离 | 保留全库 clear 给显式用户动作 |
| 5 | clear 与 AI cache write、旧缓存回填可以互相越过 | clear 是缓存线性化点 | 统一缓存写入 lane，移除旧条目回填 |
| 6 | lexicon 多处使用 `get` 后 `put/delete` | vocabulary 必须原子转换 | 改为 readwrite transaction |
| 7 | hidden gloss outcome 可以移除正在显示制卡反馈的 wrapper | card feedback 优先 | 固定 underlay 与 badge 的独立职责 |
| 8 | 一次 AI 响应允许多卡和空卡，partial success 最终显示单个错误徽标 | 一次点击只表达一张卡 | 收敛为恰好一张卡 |
| 9 | 同一 occurrence 可重复排队，客户端 timeout 不包含 lane 等待 | pending occurrence 只有一个操作 | content 复用 pending 操作 |
| 10 | Anki 传输错误统一显示确定失败 | 外部提交边界必须可判定 | 区分 definite 与 outcome unknown |
| 11 | options/onboarding 在异步初始读取期间允许交互 | loading 表单不可编辑 | ready 前设置 form inert |
| 12 | Anki catalog 完成结果未绑定当前 endpoint/revision | 只提交 current result | catalog task 加 key 与 revision gate |
| 13 | 词汇列表读取与增删清可并行完成并互相覆盖 UI | destructive task 必须排他 | 使用单一 UI operation lane |
| 14 | content control listener 在完整 boot 后才注册，popup 用固定六秒猜测启动完成 | booting 必须可观察 | 提前注册并返回显式 lifecycle phase |
| 15 | popup 根据缓存状态计算 desired state，并从全 frame 广播中接收非确定 frame 的响应 | 顶层 frame 是唯一 owner | 顶层原子 toggle 后广播结果 |
| 16 | content 与 background 在 scan start 两侧独立读取设置，可能组合旧词表与新生成配置 | scan snapshot 必须一致 | start 携带并校验 `scanConfigHash` |
| 17 | settings change 可以并行运行多个 reconcile，scan 没有统一的依赖快照提交点 | 只提交 current dependency | desired snapshot 立即替换，异步依赖按 revision 提交 |
| 18 | `scheduleScan` 的异步失败缺少统一 terminal 处理，start 发送失败会留下已登记 session | 所有 attempt 都必须到 closed | 统一 error effect 与 session cleanup |

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
| 按住 Alt 后按一次翻译组合键并继续按住 | 首个非 repeat keydown 只 toggle 一次，后续 repeat 不再 toggle |
| 按住 Alt 后按非翻译组合键，例如 Alt+Tab | selection 先退出 held，但第二个 keydown 不被消费，原组合键继续传递 |
| 两个快捷键被旧设置配置成相同值 | translation 按固定优先级执行；设置页拒绝再次保存该冲突值 |
