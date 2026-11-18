const ORDERABLE = 'orderable';
const DISCONTINUED = 'discontinued';

function timestamp(value) {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

function olderFirst(a, b) {
  const aTime = timestamp(a.observedAt);
  const bTime = timestamp(b.observedAt);
  if (aTime === null && bTime === null) return 0;
  if (aTime === null) return 1;
  if (bTime === null) return -1;
  return aTime - bTime;
}

function addEdge(map, from, to) {
  if (!map.has(from)) map.set(from, new Set());
  map.get(from).add(to);
}

/**
 * 目录索引把“替代”与“被替代”两个方向合起来看。
 * 制造商可能只在替代品的记录里写“替代了谁”，原型号记录本身没有后继字段；
 * 两个方向都建边后，任一方向的声明都能还原完整的型号关系。
 */
function buildIndex(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const forward = new Map();
  const backward = new Map();
  for (const record of records) {
    for (const relation of record.relations ?? []) {
      if (relation.kind === 'replacedBy') {
        addEdge(forward, record.id, relation.target);
        addEdge(backward, relation.target, record.id);
      } else if (relation.kind === 'replaces') {
        addEdge(backward, record.id, relation.target);
        addEdge(forward, relation.target, record.id);
      }
    }
  }
  return { byId, forward, backward, records };
}

function successorIds(index, id) {
  return [...(index.forward.get(id) ?? [])];
}

function predecessorIds(index, id) {
  return [...(index.backward.get(id) ?? [])];
}

function asCandidate(index, id) {
  const record = index.byId.get(id);
  if (!record) {
    return {
      id,
      name: null,
      status: 'missing',
      orderable: false,
      discontinued: false,
      observedAt: null,
      inCatalog: false,
    };
  }
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    orderable: record.status === ORDERABLE,
    discontinued: record.status === DISCONTINUED,
    observedAt: record.observedAt,
    inCatalog: true,
  };
}

/** 沿替代链寻找仍然可订购的后继型号，同时防止环导致死循环。 */
function orderableDescendants(index, id, seen = new Set(), depth = 0) {
  if (depth > 8) return [];
  const result = [];
  for (const nextId of successorIds(index, id)) {
    if (seen.has(nextId)) continue;
    seen.add(nextId);
    const candidate = asCandidate(index, nextId);
    if (candidate.orderable) {
      result.push({ ...candidate, depth: depth + 1 });
    } else if (candidate.inCatalog) {
      result.push(...orderableDescendants(index, nextId, seen, depth + 1));
    }
  }
  return result;
}

function buildLineage(record, index) {
  const nodes = new Map();
  const walk = (startId, neighbours, direction) => {
    const queue = [{ id: startId, depth: 0 }];
    const visited = new Set([startId]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= 8) continue;
      for (const nextId of neighbours(index, current.id)) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        const entry = index.byId.get(nextId);
        nodes.set(nextId, {
          ...asCandidate(index, nextId),
          depth: current.depth + 1,
          via: direction,
        });
        if (entry) queue.push({ id: nextId, depth: current.depth + 1 });
      }
    }
  };
  walk(record.id, successorIds, 'successor');
  walk(record.id, predecessorIds, 'predecessor');

  const timeline = [];
  const pushEdge = (from, to, relation, fallback) => {
    timeline.push({
      from,
      to,
      observedAt: relation?.observedAt ?? fallback?.observedAt ?? null,
      firstObservedAt:
        relation?.firstObservedAt ?? relation?.observedAt ?? fallback?.observedAt ?? null,
      revision: relation?.revision ?? fallback?.revision ?? 0,
    });
  };
  for (const relation of record.relations ?? []) {
    if (relation.kind === 'replacedBy') pushEdge(record.id, relation.target, relation, record);
    if (relation.kind === 'replaces') pushEdge(relation.target, record.id, relation, record);
  }
  // 反向声明（替代品写明“替代了谁”）也记入原型号的时间线。
  for (const successorId of successorIds(index, record.id)) {
    const successor = index.byId.get(successorId);
    if (!successor) continue;
    for (const relation of successor.relations ?? []) {
      if (relation.kind === 'replaces' && relation.target === record.id) {
        pushEdge(record.id, successorId, relation, successor);
      }
    }
  }
  timeline.sort(olderFirst);

  // 同一个替代关系可能由两个方向各声明一次，时间线上只保留一条，
  // 但记录最早被观察到的时间，避免后到的更新掩盖关系的起点。
  const deduped = new Map();
  for (const edge of timeline) {
    const key = `${edge.from}->${edge.to}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, edge);
      continue;
    }
    const existingFirst = timestamp(existing.firstObservedAt);
    const edgeFirst = timestamp(edge.firstObservedAt);
    deduped.set(key, {
      ...existing,
      observedAt: olderFirst(existing, edge) === 0 ? existing.observedAt : null,
      firstObservedAt:
        existingFirst === null
          ? edge.firstObservedAt
          : edgeFirst === null
            ? existing.firstObservedAt
            : edgeFirst < existingFirst
              ? edge.firstObservedAt
              : existing.firstObservedAt,
      revision: Math.min(existing.revision ?? 0, edge.revision ?? 0),
    });
  }

  return {
    predecessors: [...nodes.values()]
      .filter((entry) => entry.via === 'predecessor')
      .sort((a, b) => a.depth - b.depth || olderFirst(a, b)),
    successors: [...nodes.values()]
      .filter((entry) => entry.via === 'successor')
      .sort((a, b) => a.depth - b.depth || olderFirst(a, b)),
    timeline: [...deduped.values()].sort(olderFirst),
  };
}

function buildNote({ record, reason, orderableSuccessors, missingSuccessors }) {
  if (reason === 'current') return '当前型号可订购。';
  if (reason === 'replaced') {
    const names = orderableSuccessors
      .map((entry) => `${entry.id}（${entry.name ?? '未在本目录中'}）`)
      .join('、');
    return `原型号 ${record.id} 已停产，可订购的替代型号为 ${names}；下单请使用替代型号，不要沿用原型号。`;
  }
  if (reason === 'discontinued') {
    const unknown = missingSuccessors.map((entry) => entry.id);
    const suffix =
      unknown.length > 0 ? `；替代型号 ${unknown.join('、')} 尚未出现在目录中。` : '。';
    return `原型号 ${record.id} 已停产，未找到可订购的替代型号${suffix}`;
  }
  if (reason === 'pending') return '状态待定，暂不能确认可订购。';
  if (reason === 'unavailable') return '当前不可订购，且未标记停产。';
  return '来源未给出足够的可订购信息。';
}

/**
 * 为一条记录整理“能否订购”的答案，并解释为什么。
 * 停产的原型号不会被替换型号覆盖，历史方案仍能查到原始型号。
 */
function describe(record, index) {
  const successors = successorIds(index, record.id).map((id) => asCandidate(index, id));
  const predecessors = predecessorIds(index, record.id).map((id) => asCandidate(index, id));
  const orderableSuccessors = orderableDescendants(index, record.id);
  const missingSuccessors = successors.filter((entry) => !entry.inCatalog);

  const orderable = record.status === ORDERABLE;
  const discontinued = record.status === DISCONTINUED;

  let reason;
  if (orderable) {
    reason = 'current';
  } else if (discontinued && orderableSuccessors.length > 0) {
    reason = 'replaced';
  } else if (discontinued) {
    reason = 'discontinued';
  } else if (record.status === 'pending') {
    reason = 'pending';
  } else if (record.status === 'unavailable') {
    reason = 'unavailable';
  } else {
    reason = 'unknown';
  }

  return {
    source: record.source,
    id: record.id,
    name: record.name,
    status: record.status,
    orderable,
    discontinued,
    procurement: {
      orderable,
      reason,
      // 可以下单时给出自身型号；停产时只给替代型号，绝不把替代型号冒名为原型号。
      orderAs: orderable ? { id: record.id, name: record.name, substitute: false } : null,
      alternatives: successors,
      orderableAlternatives: orderableSuccessors,
      missingAlternatives: missingSuccessors.map((entry) => ({ id: entry.id, inCatalog: false })),
      note: buildNote({ record, reason, orderableSuccessors, missingSuccessors }),
    },
    replacedBy: successors,
    replaces: predecessors,
    lineage: buildLineage(record, index),
    observedAt: record.observedAt,
    firstSeenAt: record.firstSeenAt ?? null,
    lastSeenAt: record.lastSeenAt ?? null,
    revision: record.revision,
  };
}

function matches(record, { status, orderable, discontinued, query }) {
  if (status && record.status !== status) return false;
  if (orderable !== undefined && (record.status === ORDERABLE) !== orderable) return false;
  if (discontinued !== undefined && (record.status === DISCONTINUED) !== discontinued) return false;
  if (query) {
    const needle = String(query).trim().toLowerCase();
    if (!record.id.toLowerCase().includes(needle) && !record.name.toLowerCase().includes(needle)) {
      return false;
    }
  }
  return true;
}

/**
 * 目录查询：每一条来源记录各占一条，停产原型号与替代型号分别保留，
 * 不会把替代型号的编号顶替成原型号。默认包含停产记录，便于历史方案回溯。
 * includeDiscontinued=false 时保留“有可订购替代”的停产型号，
 * 只隐藏既停产又无货可订的记录，避免历史型号被整条抹掉。
 */
export function queryCatalog(store, options = {}) {
  const { source, includeDiscontinued = true } = options;
  const all = store.list().filter((record) => !source || record.source === source);
  const index = buildIndex(all);
  const entries = all
    .filter((record) => matches(record, options))
    .map((record) => describe(record, index))
    .filter(
      (entry) =>
        includeDiscontinued ||
        !entry.discontinued ||
        entry.procurement.orderableAlternatives.length > 0,
    );

  return {
    total: entries.length,
    orderable: entries.filter((entry) => entry.orderable).length,
    discontinued: entries.filter((entry) => entry.discontinued).length,
    replaced: entries.filter((entry) => entry.procurement.reason === 'replaced').length,
    entries,
  };
}

/**
 * 按型号查一条记录，连同它的替代关系。
 * 历史方案里的原型号即使已经停产，也仍在这里可查。
 */
export function lookupModel(store, id, { source } = {}) {
  const records = store.list().filter((record) => record.id === String(id));
  const record = source ? records.find((entry) => entry.source === source) : records[0];
  if (!record) return undefined;
  const siblings = store.list().filter((entry) => entry.source === record.source);
  return describe(record, buildIndex(siblings));
}
