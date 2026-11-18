const DISCONTINUED_STATES = new Set([
  'discontinued',
  'obsolete',
  'retired',
  'inactive',
  'unavailable',
  '停产',
  '已停产',
  '停售',
  '已停售',
]);

const ORDERABLE_STATES = new Set([
  'active',
  'available',
  'orderable',
  'in-stock',
  'instock',
  '可订购',
  '在售',
  '供货中',
]);

const PENDING_STATES = new Set(['pending', 'draft', '待定', '待发布']);

const REPLACED_BY_KEYS = [
  'replacedBy',
  'replaced_by',
  'supersededBy',
  'superseded_by',
  'successor',
  'successors',
  'replacement',
  'replacementId',
  'replacement_id',
];

const REPLACES_KEYS = [
  'replaces',
  'replaced',
  'predecessor',
  'predecessors',
  'supersedes',
];

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function toIdList(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  const ids = values.map((entry) => {
    if (entry && typeof entry === 'object') entry = entry.id;
    return entry === undefined || entry === null ? '' : String(entry).trim();
  });
  return [...new Set(ids.filter(Boolean))];
}

export function normalizeState(value) {
  if (value === undefined || value === null) return '';
  const state = String(value).trim().toLowerCase();
  if (DISCONTINUED_STATES.has(state)) return 'discontinued';
  if (ORDERABLE_STATES.has(state)) return 'orderable';
  if (PENDING_STATES.has(state)) return 'pending';
  return state;
}

/**
 * 把来源中的生命周期信号归并为目录可用的状态。
 *
 * 显式的停产/可订购字段优先；只有在来源没有给出肯定状态时，
 * 才用“存在替代型号”推断为停产。替代关系本身始终保留在记录里，
 * 不因为状态推断而与原型号分离。
 */
export function deriveStatus({ state, status, discontinued, orderable, replacedBy = [] }) {
  const normalizedState = normalizeState(state);
  const normalizedStatus = normalizeState(status);

  if (
    discontinued === true ||
    normalizedState === 'discontinued' ||
    normalizedStatus === 'discontinued'
  ) {
    return 'discontinued';
  }

  if (orderable === true) return 'orderable';
  if (normalizedState === 'pending' || normalizedStatus === 'pending') return 'pending';
  if (orderable === false) return 'unavailable';

  // 来源明确写了替代型号，但没有给出可用状态：按已被替代处理。
  if (replacedBy.length > 0) return 'discontinued';

  if (normalizedState === 'orderable' || normalizedStatus === 'orderable') return 'orderable';
  return 'unknown';
}

export function normalizePage(page) {
  return page.items.map((item) => {
    const id = item.id === undefined || item.id === null ? '' : String(item.id).trim();
    const name = String(item.label ?? item.name ?? '').trim();
    if (!id || !name) {
      throw new Error('来源记录缺少 id 或 label/name');
    }

    const replacedBy = toIdList(firstDefined(item, REPLACED_BY_KEYS)).filter(
      (target) => target !== id,
    );
    const replaces = toIdList(firstDefined(item, REPLACES_KEYS)).filter(
      (target) => target !== id,
    );

    const hasLifecycleSignal =
      item.state !== undefined ||
      item.status !== undefined ||
      item.orderable !== undefined ||
      item.discontinued !== undefined ||
      replacedBy.length > 0 ||
      replaces.length > 0;
    if (!hasLifecycleSignal) {
      throw new Error('来源记录缺少 state/status、orderable 或替代关系');
    }

    const status = deriveStatus({
      state: item.state,
      status: item.status,
      discontinued: item.discontinued,
      orderable: item.orderable,
      replacedBy,
    });
    const revisionValue = Number(item.revision ?? 0);
    const revision = Number.isFinite(revisionValue) ? revisionValue : 0;
    const observedAt = item.observedAt ?? page.observedAt ?? null;
    const relationBase = { source: page.source, revision, observedAt };

    return {
      source: page.source,
      id,
      name,
      state: item.state === undefined || item.state === null ? null : String(item.state),
      declaredStatus: item.status === undefined || item.status === null ? null : String(item.status),
      declaredDiscontinued:
        item.discontinued === undefined || item.discontinued === null
          ? null
          : Boolean(item.discontinued),
      declaredOrderable:
        item.orderable === undefined || item.orderable === null ? null : Boolean(item.orderable),
      status,
      orderable: status === 'orderable',
      discontinued: status === 'discontinued',
      revision,
      observedAt,
      replacedBy,
      replaces,
      relations: [
        ...replacedBy.map((target) => ({ ...relationBase, kind: 'replacedBy', target })),
        ...replaces.map((target) => ({ ...relationBase, kind: 'replaces', target })),
      ],
    };
  });
}
