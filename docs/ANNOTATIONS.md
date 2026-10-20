# 币种标注

用户 2026-10-20：「加入新功能，标注模块，主要就是在合约行情界面会显示我对币种的标注数据，
大概就是杂毛，异能等这些标签能显示标注的时间多长时间之前……在 K 线页面顶部右侧加一个按钮
在测试旁第一个，点击之后可以底部弹窗可以打标签和描述，标签是可选的可维护的……打的标签在
K 线显示在底部显示所有历史标签和时间，底部还要加一个类似横幅通知那样字体滚动显示最新的
标签描述和时间，历史标注可折叠」。

2026-10-20 追加：

- 合约行情里**标签放在币种后面、上面那一行，带颜色**；
- 标签可以选颜色；管理标签最底下是一个颜色圆圈，点开有快捷色 + 完整颜色选择器；
- 新加标签默认不弹颜色；
- 最新横幅和历史标注挪到**开仓按钮下面**。

## 它是什么

- **按用户、按币种**记一条「我当时怎么看这个币」：一组标签 + 一句描述 + 保存时刻。
- 不是预测历史，也不是交易日记：预测历史是模型结论，日记是整篇感想，标注是**贴在币上的短记**。
- 时间只由服务端 `now()` 决定（按保存那一刻），不绑定某根 K 线 / 某个价格。

## 数据表

两张表，建表见 `backend/src/db/schema.ts`：

### `annotation_tags`

标签词表（杂毛 / 异能 …），只用来给弹窗挑。

| 列 | 说明 |
| --- | --- |
| `id` | 主键 |
| `user_id` | 用户（`ON DELETE CASCADE`） |
| `name` | 标签名（最长 12 字，同一用户不区分大小写唯一） |
| `color` | 标签色（`#rrggbb`；老标签为空时列表接口按调色板补一个） |
| `sort` | 维护顺序 |
| `created_at` | 创建时刻 |

### `symbol_annotations`

一条标注 = 一个币 + 当时选中的标签名 + 描述 + 时刻。

| 列 | 说明 |
| --- | --- |
| `id` | 主键 |
| `user_id` | 用户（`ON DELETE CASCADE`） |
| `base` | 基础币（`BTC`，不带 `/USDT`） |
| `tags` | 标签名数组（JSONB，如 `["杂毛","异能"]`） |
| `note` | 描述（可空，最长 500 字） |
| `created_at` | 标注时刻 |

索引：`(user_id, base, created_at DESC, id DESC)` 走某币历史；
`(user_id, created_at DESC, id DESC)` 走「每个币最新一条」。

`users.annotation_tags_seeded_at` 只用来判断默认标签有没有播种过：第一次列标签时种下
`杂毛` / `异能` 并写 `now()`；用户删光后不会自己长回来。

## 标签语义

- 标注里存的是**名字快照**，不是标签 id。
- **颜色属于标签词表**（不是单条标注）：行情行、弹窗、历史区都按名字现查颜色；
  词表里删掉的旧标签，历史里按名字散列到调色板的一个兜底色。
- **改名**：后端会把历史标注里的同名标签一起改（`jsonb_array_elements ... WITH ORDINALITY`，
  保持顺序）。理由：用户维护的是同一份标签口径，改名后旧记录还挂旧名字会让行情列表和
  K 线历史同时出现两个看起来是一回事的标签。颜色跟着标签走，不用动历史。
- **改色**：只动 `annotation_tags.color`，历史里存的是名字，天然跟着新颜色。
- **删除标签**：不动历史里的名字。历史是「当时贴了什么」，词表只是以后可选的集合。
- 新增标签不指定颜色时，后端按调色板顺序给一个默认色；老标签（没有 color 列时建的）
  在第一次列词表时补默认色。
- 每条标注最多 8 个标签；每用户最多 50 个标签；标签和描述至少写一样。

## 接口

全部要登录，全部按 `user_id` 隔离（`backend/src/server.ts`，实现见 `db/annotations.ts`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/annotations` | `{tags, latest: {BTC: {id, base, tags, note, at}}}`，每个币最新一条 |
| GET | `/api/annotations?base=BTC` | `{tags, entries: [...]}`，某币全部历史（新的在前，最多 200 条） |
| POST | `/api/annotations` | body `{base, tags?, note?}` → `{entry}` |
| DELETE | `/api/annotations/:id` | `{ok}`，只能删自己的 |
| POST | `/api/annotation-tags` | body `{name, color?}` → `{tag, tags}`；不传 color 用默认色 |
| POST | `/api/annotation-tags/:id` | body `{name?, color?}` → `{tag, tags}`（改名 / 改色；改名时历史同步） |
| DELETE | `/api/annotation-tags/:id` | `{tags}`（历史不动） |

`tags[]` / `tag` 里都带 `color`（`#rrggbb`）。`at` 是 ISO 时间；前端用 `format.ts` 的
`ago()` 转成「几分钟前」。

## 前端

| 文件 | 作用 |
| --- | --- |
| `frontend/src/annotations.ts` | 模块级 store：标签词表（含颜色）/ 最新一条 / 某个币的历史；20 秒新鲜度 + 请求序号防串；`tagColorOf` / `tagChipStyle` |
| `frontend/src/comps/AnnotationSheet.vue` | 底部弹窗：彩色多选标签、快速加标签、管理（颜色 / 改名 / 删除）、描述 |
| `frontend/src/comps/SymbolAnnotations.vue` | 开仓按钮下方：最新一条滚动横幅 + 可折叠历史（彩色标签） |
| `frontend/src/comps/MarketPanel.vue` | 合约行情币种后面一行彩色标签 + 第二行「N 分钟前」 |
| `frontend/src/views/AnalyzeView.vue` | 顶部按钮（测试左边第一颗）、开仓按钮下方标注区、弹窗入口 |

界面口径：

- 行情列表只显示**最新一条**的标签（最多 3 个，其余折成 `+N`），放在**币种后面那一行**，
  每个标签按词表颜色画；时间在第二行末尾。没标注的行不增加行高。
- K 线顶部按钮有标注时染主题金色；点开是底部弹窗。
- 弹窗里标签胶囊本身带颜色；「管理标签」每行有一个颜色圆圈，点它会在管理区**最底下**
  打开颜色编辑器：10 个快捷色 + 完整颜色选择器。新加标签默认不自动弹颜色。
- 最新横幅 + 历史区放在**做多 / 做空按钮下面**（`OrderPanel` 之后）。
- 横幅：标签 / 描述 + 时间，文字超出容器才滚；悬停暂停；`prefers-reduced-motion`
  下不滚；「最新」那枚小标跟着最新标签的颜色。
- 历史区默认展开、可折叠，列表最高约 140px 内部滚动；每条可删（确认框）。
- 当前币没有标注时，开仓按钮下面整块不渲染。

## 自测

```bash
npm run typecheck
npm run ui:build
npm run selftest
```

本地起服务后（`npm run web`），可用 `/api/auth/dev-login` 拿 token 走一遍：

1. 首次 GET `/api/annotations` 出现 `杂毛` / `异能`；
2. POST 一条标注 → GET 汇总能看到最新一条；
3. GET `?base=` 历史新的在前；
4. 改名标签 → 历史里的同名标签同步变；
5. 改标签颜色 → 行情行 / 弹窗 / 历史里的同一个标签一起变色；
6. 删除标签 → 历史名字保留（颜色按名字兜底）、词表里消失；
7. DELETE 标注 → 汇总 / 历史都消失；
8. 未登录 GET 返回 401。
