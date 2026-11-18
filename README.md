# 实验室耗材目录采集服务

这是一个用于实验室耗材目录的本地数据采集与归档服务。当前版本从仓库自带的合成来源记录读取一页数据，经过字段规整后写入进程内目录；来源内容和规整后的记录保留独立边界，便于在不访问外部系统的情况下复现采集过程。

## 生命周期与替代关系

来源记录除 `id`、`label` 外，还可以带：

- `state` / `status`：`active`、`pending`、`discontinued` 等，也接受 `orderable`、`停产` 等写法；
- `orderable`、`discontinued`：显式的布尔状态；
- `replacedBy`：该型号的替代型号编号，可以是字符串或数组；
- `replaces`：该型号替代了哪些旧型号。

规整后每条记录都有 `status`（`orderable` / `pending` / `discontinued` / `unavailable` / `unknown`）、`orderable`、`discontinued`、`replacedBy`、`replaces`。停产的原型号和替代型号各自是一条记录，不会被合并，也不会把替代型号的编号冒充成原型号。

制造商可能只在替代品的记录里写 `replaces`，或者在原型号记录里写 `replacedBy`；存储层会把关系补成双向，并在 `relationLog()` 里保留每条关系的首次出现时间与来源修订号。不同页面观察时间不一致时：

- 字段仍按“修订号优先，其次来源观察时间”更新；
- 已经记录过的替代关系不会因为旧页面晚到或新页面没写而消失；
- 若替代声明比该型号自身状态的观察时间更晚，原型号按“已被替代”处理；更老的替代声明只保留关系，不改写更新的可用状态。

## 目录查询

`collect()` 的返回值里包含 `catalog`。也可以直接用存储实例查询：

```js
import { collect } from './src/pipeline.mjs';
import { lookupModel, queryCatalog } from './src/catalog.mjs';

const { store } = await collect();
queryCatalog(store, { query: '样例', orderable: true });
lookupModel(store, '4-C');
```

查询结果中：

- `procurement.orderable` 是能否下单；`procurement.orderAs` 只在当前型号自身可订购时给出，停产型号为 `null`；
- `procurement.alternatives` 列出直接替代型号，`orderableAlternatives` 沿替代链找到真正可订购的型号（会跳过同样停产的中间型号）；
- `procurement.reason` 区分 `current`、`replaced`、`discontinued`、`pending`、`unavailable`、`unknown`；
- `lineage.timeline` 保留型号关系的观察时间和首次出现时间，`lineage.successors` / `predecessors` 给出多级替代链。

默认查询包含停产记录；`includeDiscontinued: false` 只隐藏既停产又没有任何可订购替代的记录。

## 运行

需要 Node.js 20 或更高版本，不需要安装第三方依赖。

```sh
npm test
npm run build
node src/pipeline.mjs
```

测试使用项目内的合成记录；执行不需要网络、凭据或外部服务。
