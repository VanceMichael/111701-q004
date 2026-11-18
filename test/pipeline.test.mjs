import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, normalizePage } from '../src/adapter.mjs';
import { collect } from '../src/pipeline.mjs';
import { lookupModel, queryCatalog } from '../src/catalog.mjs';
import { RecordStore } from '../src/store.mjs';

const page = (items, observedAt = '2026-11-17T08:00:00.000Z') => ({
  source: 'local',
  observedAt,
  items,
});

test('采集链保留来源、记录身份和观察时间', async () => {
  const store = new RecordStore();
  const result = await collect({
    source: async () =>
      page([{ id: 'a', label: '样例记录', state: 'active', revision: 1 }]),
    store,
  });
  assert.equal(result.records[0].source, 'local');
  assert.equal(result.records[0].id, 'a');
  assert.equal(result.records[0].observedAt, '2026-11-17T08:00:00.000Z');
  assert.equal(store.list().length, 1);
});

test('重复身份按较新的修订号更新', () => {
  const store = new RecordStore();
  store.save({ source: 'local', id: 'a', name: '旧值', state: 'active', revision: 1 });
  store.save({ source: 'local', id: 'a', name: '新值', state: 'active', revision: 2 });
  assert.equal(store.list()[0].name, '新值');
});

test('不完整来源记录被拒绝', () => {
  assert.throws(() => normalizePage({ source: 'local', items: [{ id: 'a' }] }));
  assert.throws(() => normalizePage({ source: 'local', items: [{ label: '无编号', state: 'active' }] }));
});

test('停产原型号与替代型号分别建账，不互相冒名', async () => {
  const { store, catalog } = await collect({
    source: async () =>
      page([
        { id: 'old', label: '旧型号', state: 'discontinued', replacedBy: 'new', revision: 2 },
        { id: 'new', label: '替代型号', state: 'active', replaces: 'old', revision: 1 },
      ]),
  });

  const oldEntry = lookupModel(store, 'old');
  assert.equal(oldEntry.id, 'old');
  assert.equal(oldEntry.status, 'discontinued');
  assert.equal(oldEntry.procurement.orderable, false);
  assert.equal(oldEntry.procurement.reason, 'replaced');
  assert.deepEqual(
    oldEntry.procurement.alternatives.map((entry) => entry.id),
    ['new'],
  );
  assert.equal(oldEntry.procurement.orderAs, null);
  assert.match(oldEntry.procurement.note, /下单请使用替代型号/);

  const newEntry = lookupModel(store, 'new');
  assert.equal(newEntry.status, 'orderable');
  assert.equal(newEntry.procurement.orderAs.id, 'new');

  // 两条记录都在目录里，历史方案仍能按原型号查到。
  assert.equal(catalog.total, 2);
  assert.equal(catalog.discontinued, 1);
  assert.equal(catalog.replaced, 1);
});

test('替代型号在不同页面、不同时间出现时保留关系来龙去脉', async () => {
  const store = new RecordStore();
  const first = await collect({
    source: async () =>
      page(
        [{ id: 'old', label: '旧型号', state: 'discontinued', revision: 1 }],
        '2026-11-01T00:00:00.000Z',
      ),
    store,
  });
  assert.equal(first.records[0].status, 'discontinued');

  const second = await collect({
    source: async () =>
      page(
        [{ id: 'old', label: '旧型号', state: 'discontinued', replacedBy: 'new', revision: 2 }],
        '2026-11-10T00:00:00.000Z',
      ),
    store,
  });
  const updated = second.records[0];
  assert.deepEqual(updated.replacedBy, ['new']);
  assert.equal(updated.firstSeenAt, '2026-11-01T00:00:00.000Z');
  assert.equal(updated.lastSeenAt, '2026-11-10T00:00:00.000Z');

  const relation = updated.relations.find((entry) => entry.kind === 'replacedBy');
  assert.equal(relation.observedAt, '2026-11-10T00:00:00.000Z');
  assert.equal(relation.firstObservedAt, '2026-11-10T00:00:00.000Z');
  assert.ok(store.relationLog().some((event) => event.from === 'old' && event.to === 'new'));

  // 替代型号晚一页到货，也能补全原型号的关系。
  await collect({
    source: async () =>
      page(
        [{ id: 'new', label: '替代型号', state: 'active', replaces: 'old', revision: 1 }],
        '2026-11-12T00:00:00.000Z',
      ),
    store,
  });
  const oldEntry = lookupModel(store, 'old');
  assert.equal(oldEntry.lineage.successors[0].id, 'new');
  assert.equal(oldEntry.lineage.successors[0].inCatalog, true);
  assert.ok(oldEntry.lineage.timeline.length >= 1);
  assert.equal(queryCatalog(store).replaced, 1);
});

test('旧页面晚到不会抹掉新页面已记录的关系', async () => {
  const store = new RecordStore();
  store.save(
    normalizePage(
      page(
        [{ id: 'old', label: '旧型号', state: 'discontinued', replacedBy: 'new', revision: 2 }],
        '2026-11-10T00:00:00.000Z',
      ),
    )[0],
  );
  store.save(
    normalizePage(
      page(
        [{ id: 'old', label: '旧型号', state: 'active', revision: 1 }],
        '2026-11-01T00:00:00.000Z',
      ),
    )[0],
  );

  const entry = lookupModel(store, 'old');
  assert.deepEqual(entry.replacedBy.map((item) => item.id), ['new']);
  assert.equal(entry.status, 'discontinued');
  assert.equal(entry.observedAt, '2026-11-10T00:00:00.000Z');
  assert.equal(entry.firstSeenAt, '2026-11-10T00:00:00.000Z');
});

test('状态推导不把显式可订购误判为停产', () => {
  assert.equal(deriveStatus({ state: 'active' }), 'orderable');
  assert.equal(deriveStatus({ state: 'discontinued', replacedBy: ['x'] }), 'discontinued');
  assert.equal(deriveStatus({ orderable: true, status: 'active' }), 'orderable');
  assert.equal(deriveStatus({ orderable: false }), 'unavailable');
  assert.equal(deriveStatus({ state: 'pending' }), 'pending');
  // 只给了替代关系、没有明确可用状态时按已替代处理。
  assert.equal(deriveStatus({ replacedBy: ['x'] }), 'discontinued');
});

test('目录查询可按状态和关键字筛选，并保留停产记录', async () => {
  const { store } = await collect({
    source: async () =>
      page([
        { id: 'old', label: '旧型号', state: 'discontinued', replacedBy: 'new', revision: 2 },
        { id: 'new', label: '替代型号', state: 'active', revision: 1 },
        { id: 'gone', label: '无后继的停产件', state: 'discontinued', revision: 1 },
        { id: 'pending', label: '待定件', state: 'pending', revision: 1 },
      ]),
  });

  const all = queryCatalog(store);
  assert.equal(all.total, 4);
  assert.equal(all.discontinued, 2);
  assert.equal(all.orderable, 1);

  const onlyOrderable = queryCatalog(store, { orderable: true });
  assert.deepEqual(onlyOrderable.entries.map((entry) => entry.id), ['new']);

  const keyword = queryCatalog(store, { query: '替代' });
  assert.deepEqual(keyword.entries.map((entry) => entry.id), ['new']);

  // 默认保留无替代的停产件，作为历史型号仍可查询。
  assert.ok(all.entries.some((entry) => entry.id === 'gone'));

  const activeOnly = queryCatalog(store, { includeDiscontinued: false });
  assert.ok(!activeOnly.entries.some((entry) => entry.id === 'gone'));
  assert.ok(activeOnly.entries.some((entry) => entry.id === 'old'));
});

test('替代关系缺失的型号会被明确标出，而不是静默当成可订购', async () => {
  const { store } = await collect({
    source: async () =>
      page([{ id: 'old', label: '旧型号', state: 'discontinued', replacedBy: 'ghost', revision: 1 }]),
  });
  const entry = lookupModel(store, 'old');
  assert.equal(entry.procurement.orderable, false);
  assert.deepEqual(entry.procurement.missingAlternatives, [{ id: 'ghost', inCatalog: false }]);
  assert.match(entry.procurement.note, /尚未出现在目录中/);
});

test('只在替代品记录里声明替代关系时，原型号也能查到后继', () => {
  const store = new RecordStore();
  const save = (item, at) =>
    store.save(normalizePage(page([item], at))[0]);

  // 替代品先到，且制造商只在这一条记录写了“替代了 old”。
  save({ id: 'new', label: '替代型号', state: 'active', replaces: 'old', revision: 1 }, '2026-11-10T00:00:00.000Z');
  save({ id: 'old', label: '旧型号', state: 'active', revision: 1 }, '2026-11-01T00:00:00.000Z');

  const entry = lookupModel(store, 'old');
  assert.deepEqual(entry.replacedBy.map((item) => item.id), ['new']);
  assert.equal(entry.status, 'discontinued');
  assert.equal(entry.procurement.reason, 'replaced');
  assert.deepEqual(entry.procurement.orderableAlternatives.map((item) => item.id), ['new']);
  // 时间线只保留一条关系，不因双向声明重复。
  assert.equal(entry.lineage.timeline.length, 1);
  assert.equal(entry.lineage.timeline[0].firstObservedAt, '2026-11-10T00:00:00.000Z');
  assert.ok(store.relationLog().some((event) => event.derived === true));
});

test('更老的替代声明不会推翻更晚观察到的可用状态', () => {
  const store = new RecordStore();
  const save = (item, at) => store.save(normalizePage(page([item], at))[0]);

  save({ id: 'new', label: '替代型号', state: 'active', replaces: 'old', revision: 1 }, '2026-11-01T00:00:00.000Z');
  save({ id: 'old', label: '旧型号', state: 'active', revision: 1 }, '2026-11-10T00:00:00.000Z');

  const entry = lookupModel(store, 'old');
  assert.equal(entry.status, 'orderable');
  assert.equal(entry.observedAt, '2026-11-10T00:00:00.000Z');
  // 关系仍保留，供采购人员核对来源。
  assert.deepEqual(entry.replacedBy.map((item) => item.id), ['new']);
});

test('多级替代链能找到最终可订购型号，且环形关系不会死循环', () => {
  const store = new RecordStore();
  const save = (items, at) => {
    for (const record of normalizePage(page(items, at))) store.save(record);
  };

  save(
    [
      { id: 'v1', label: '第一代', state: 'discontinued', replacedBy: 'v2', revision: 1 },
      { id: 'v2', label: '第二代', state: 'discontinued', replacedBy: 'v3', revision: 1 },
      { id: 'v3', label: '第三代', state: 'active', revision: 1 },
    ],
    '2026-11-10T00:00:00.000Z',
  );

  const entry = lookupModel(store, 'v1');
  assert.deepEqual(
    entry.procurement.orderableAlternatives.map((item) => `${item.id}:${item.depth}`),
    ['v3:2'],
  );
  assert.deepEqual(entry.lineage.successors.map((item) => item.id), ['v2', 'v3']);

  const cyclic = new RecordStore();
  cyclic.save(
    normalizePage(
      page([
        { id: 'a', label: '甲', state: 'discontinued', replacedBy: 'b', revision: 1 },
        { id: 'b', label: '乙', state: 'discontinued', replacedBy: 'a', revision: 1 },
      ]),
    )[0],
  );
  cyclic.save(
    normalizePage(
      page([{ id: 'b', label: '乙', state: 'discontinued', replacedBy: 'a', revision: 1 }]),
    )[0],
  );
  const cyclicEntry = lookupModel(cyclic, 'a');
  assert.equal(cyclicEntry.procurement.orderable, false);
  assert.equal(cyclicEntry.procurement.reason, 'discontinued');
  assert.ok(cyclicEntry.lineage.successors.length <= 1);
});
