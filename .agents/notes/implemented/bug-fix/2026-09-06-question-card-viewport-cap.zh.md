# Agent Note: 问题接管卡片以实测滚动视口为高度上限

Status: implemented

[English](2026-09-06-question-card-viewport-cap.md) | 中文

## 问题

在手机上，`ask_user_question` 接管卡片可能出现头部（眉标、问题标题、最小化/关闭按钮）被切出屏幕顶部的情况：第一个选项行在会话标签页正下方被切掉半个字，卡片悬在列中间、下方留出死空间。计划评审卡片共享同一几何结构，也共享同一失败模式。

卡片在会话滚动视口内的粘性 composer 坐席（`bottom: 0`）中以 `max-height: min(60vh, 520px)` 封顶。`vh` 相对手机浏览器可能达到的最大视口（URL 栏隐藏、键盘收起）解析，而不是当前实际视口，所以该上限可能承诺比列当前拥有的更多高度——URL 栏显示、系统字体缩放、或更高的窄屏堆叠头部都会让坐席比滚动视口高。粘性元素无法离开其滚动视口：超出部分伸向滚动边缘上方，滚动无法到达，卡片头部被切掉。接管期间 composer 工具栏是 `display: none`，被切卡片下方的条带因此成了没有任何可点目标的死空间——同时读起来就是"弹框溢出、底部栏点击没反应"。

## 决定

**接管卡片的 `max-height` 增加一项来自实测滚动视口的值，凡是视口单位项与现实不符，这一项获胜。** `QuestionComposer.module.css` 与 `PlanReviewPanel.module.css` 都改为

```css
max-height: min(
  60vh,
  520px,
  calc(var(--dsh-conversation-viewport-height, 100dvh) - 16px)
);
```

`--dsh-conversation-viewport-height` 是 `ConversationRoot` 已发布在滚动容器上的滚动视口 `clientHeight`（与 `TurnNavigator` 消费的是同一变量）；`100dvh` 承担其观察器触发前的首帧绘制，`16px` 是 frame 自身的垂直内边距（上 6px + 下 10px）。因此在任何动态视口条件下——URL 栏过渡、键盘调整模式、分屏、`vh`/ICB 错配——卡片都不会超出粘性坐席实际拥有的空间。`60vh` 和 `520px` 在正常屏幕上继续承担原有的美观上限角色；只有列真正局促时实测项才生效。

## 备选方案

**把美观项换成 `dvh`/`svh`。** 作为唯一修复被否决：`dvh` 会随手机工具栏的隐藏与显示实时变化（每次工具栏过渡都重排），`svh` 依旧在猜测实时列高而不是实测。只要真实约束是会话列——头部高度与侧栏宽度——而非视口，两者都不对。

**给粘性坐席而不是卡片设上限。** 被否决：坐席是 fallback composer 与每个当选接管的共同祖先，其高度由内容驱动；在那里设上限同样需要这个变量，却把一条所有权边界（坐席属于 `ui-conversation`）耦合给单一消费者的卡片。

**在 frame 上用 `overflow: hidden` 藏起溢出。** 被否决——这正是 bug 本身：卡片已经隐藏溢出，头部才会无声消失而不是布局大声失败。

## 后果

接管卡片在手机与桌面一样，始终把头部与底部操作呈现在可见列内，选项列表（或计划正文）在内部滚动。被切卡片下方的死空间消失：坐席贴合列底，问题待答期间 composer 腾出的空间有界且显然属于接管表面。问题待答期间 composer 工具栏保持隐藏是既有接管设计，不变；该工具栏上的点击显示气泡（3 秒粗指针自动消失）不受影响，接管结束后立即恢复。

## 验证

`apps/web/tests/question-composer.e2e.ts` 在往返场景中新增手机几何断言块：360px 列宽下，接管 frame（`[data-question-key]`——卡片加上 16px frame 内边距）在 300px 高视口（实测项在此胜过 `60vh`）下轮询至稳定且不高于实测滚动视口，在 520px 下轮询标题与底部翻页器可见。该断言对仅视口单位的上限失败。已验证：`DSH_SNAPSHOT=replay npx vitest run --config vitest.web.config.ts apps/web/tests/question-composer.e2e.ts`（4 通过）；`npx vitest run packages/client/ui-user-questions packages/client/ui-primitives/tests/tooltip.client.spec.tsx`（72 通过）。360×300/520/740 下两问题批次的实测探针显示卡片分别封顶（174px / 312px / 444px），头部与底部在每个尺寸下都在屏内。
