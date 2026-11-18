import { deriveStatus } from './adapter.mjs';

const KIND_PRECEDENCE = { replacedBy: 2, replaces: 1 };
const INVERSE = { replacedBy: 'replaces', replaces: 'replacedBy' };

function clone(value) {
  return structuredClone(value);
}

function timestamp(observedAt) {
  const time = observedAt ? Date.parse(observedAt) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

function latestTime(values) {
  let latest = null;
  let latestValue = null;
  for (const value of values) {
    const time = timestamp(value);
    if (time !== null && (latest === null || time >= latest)) {
      latest = time;
      latestValue = value;
    }
  }
  return { time: latest, value: latestValue };
}

/**
 * 合并关系时以 (kind, target) 为身份：后到的记录可以补充关系的来源时间，
 * 但不会抹掉旧记录里已经声明过的关系。
 */
function mergeRelations(previous, incoming) {
  const relations = new Map();
  for (const relation of previous) {
    relations.set(`${relation.kind}:${relation.target}`, { ...relation });
  }
  for (const relation of incoming) {
    const key = `${relation.kind}:${relation.target}`;
    const existing = relations.get(key);
    if (!existing) {
      relations.set(key, { ...relation, firstObservedAt: relation.firstObservedAt ?? relation.observedAt ?? null });
      continue;
    }
    const existingTime = timestamp(existing.observedAt) ?? Number.NEGATIVE_INFINITY;
    const incomingTime = timestamp(relation.observedAt) ?? Number.NEGATIVE_INFINITY;
    const useIncoming = incomingTime >= existingTime;
    relations.set(key, {
      ...existing,
      ...(useIncoming ? relation : {}),
      // 来源后来直接写明了这条关系时，它就不再是推断出来的。
      derived: useIncoming ? relation.derived === true : existing.derived === true,
      // 第一次看到这条关系的时间不随后续更新而改变。
      firstObservedAt: existing.firstObservedAt ?? existing.observedAt ?? relation.observedAt ?? null,
    });
  }
  return [...relations.values()].sort(
    (a, b) =>
      (KIND_PRECEDENCE[b.kind] ?? 0) - (KIND_PRECEDENCE[a.kind] ?? 0) ||
      String(a.target).localeCompare(String(b.target)),
  );
}

function relationIds(relations, kind) {
  return relations.filter((relation) => relation.kind === kind).map((relation) => relation.target);
}

/**
 * 区分“来源声明的状态”和“推导出来的状态”。
 * 适配层产出的记录带有 declared* 字段；直接调用 store 传入的普通对象
 * 则以自身的 status/discontinued/orderable 作为声明值。
 */
function declaredFrom(record) {
  if (Object.hasOwn(record, 'declaredStatus')) {
    return {
      declaredStatus: record.declaredStatus ?? null,
      declaredDiscontinued: record.declaredDiscontinued ?? null,
      declaredOrderable: record.declaredOrderable ?? null,
    };
  }
  return {
    declaredStatus: record.status ?? null,
    declaredDiscontinued:
      typeof record.discontinued === 'boolean' ? record.discontinued : null,
    declaredOrderable: typeof record.orderable === 'boolean' ? record.orderable : null,
  };
}

export class RecordStore {
  #records = new Map();
  #relations = [];
  #eventKeys = new Set();

  save(rawRecord) {
    const record = { ...rawRecord, ...declaredFrom(rawRecord) };
    const key = `${record.source}:${record.id}`;
    const previous = this.#records.get(key);
    const incomingObservedAt = record.observedAt ?? null;

    if (!previous) {
      const saved = this.#compose({
        ...record,
        relations: mergeRelations([], record.relations ?? []),
        statusObservedAt: record.observedAt ?? null,
        firstSeenAt: record.observedAt ?? null,
        lastSeenAt: record.observedAt ?? null,
      });
      this.#records.set(key, saved);
      this.#reconcile();
      return clone(this.#records.get(key));
    }

    const incomingTime = timestamp(incomingObservedAt);
    const previousTime = timestamp(previous.observedAt);
    const incomingTimeKnown = incomingTime !== null;
    const previousTimeKnown = previousTime !== null;

    // 版本判断先看修订号，再以来源观察时间决胜负；缺失时间的记录不冒充“更新”。
    const acceptFields =
      record.revision > previous.revision ||
      (record.revision === previous.revision &&
        (!incomingTimeKnown || !previousTimeKnown || incomingTime >= previousTime));

    const relations = mergeRelations(previous.relations ?? [], record.relations ?? []);
    const base = acceptFields ? record : previous;
    const observedAt = acceptFields && incomingTimeKnown ? incomingObservedAt : previous.observedAt;
    const lastSeenAt =
      incomingTimeKnown && (!previousTimeKnown || incomingTime >= previousTime)
        ? incomingObservedAt
        : previous.lastSeenAt ?? previous.observedAt ?? null;
    // 状态观察时间只跟着真正改写了状态字段的那次保存走。
    const statusObservedAt = acceptFields
      ? incomingTimeKnown
        ? incomingObservedAt
        : previous.statusObservedAt ?? previous.observedAt ?? null
      : previous.statusObservedAt ?? previous.observedAt ?? null;

    const saved = this.#compose({
      ...base,
      source: record.source,
      id: record.id,
      observedAt,
      relations,
      statusObservedAt,
      firstSeenAt: previous.firstSeenAt ?? previous.observedAt ?? null,
      lastSeenAt,
    });

    this.#records.set(key, saved);
    this.#reconcile();
    return clone(this.#records.get(key));
  }

  /**
   * 把替代关系补成双向：制造商可能只在替代品的记录里写“替代了谁”，
   * 原型号记录本身没有后继字段。两个方向都建边后，任一来源声明都能还原关系。
   */
  #reconcile() {
    let changed = true;
    let guard = 0;
    while (changed && guard < 16) {
      changed = false;
      guard += 1;
      for (const record of this.#records.values()) {
        for (const relation of record.relations ?? []) {
          const targetKey = `${record.source}:${relation.target}`;
          const target = this.#records.get(targetKey);
          if (!target) continue;
          const inverseKind = INVERSE[relation.kind];
          const inverseExists = (target.relations ?? []).some(
            (entry) => entry.kind === inverseKind && entry.target === record.id,
          );
          if (!inverseExists) {
            target.relations = mergeRelations(target.relations ?? [], [
              {
                source: record.source,
                revision: relation.revision ?? record.revision ?? 0,
                observedAt: relation.observedAt ?? record.observedAt ?? null,
                firstObservedAt: relation.firstObservedAt ?? relation.observedAt ?? record.observedAt ?? null,
                kind: inverseKind,
                target: record.id,
                derived: true,
              },
            ]);
            changed = true;
          }
        }
      }
    }
    for (const record of this.#records.values()) {
      this.#compose(record);
      this.#rememberRelationEvents(record);
    }
  }

  #compose(record) {
    const relations = record.relations ?? [];
    const replacedBy = relationIds(relations, 'replacedBy');
    const replaces = relationIds(relations, 'replaces');

    // 只依据来源声明判断，绝不把上一次推导出的 status 当成新的声明。
    const declaredStatus = deriveStatus({
      state: record.state,
      status: record.declaredStatus,
      discontinued: record.declaredDiscontinued,
      orderable: record.declaredOrderable,
      replacedBy: [],
    });

    let status = declaredStatus;
    let statusReason = 'declared';
    let supersededAt = null;
    // 冲突按来源观察时间裁决：比本条状态更新的替代声明可以推翻旧状态；
    // 同一批快照里的显式状态更可信，关系仍保留，但不改写状态。
    if (replacedBy.length > 0 && declaredStatus !== 'discontinued' && declaredStatus !== 'pending') {
      const replacementRelation = latestTime(
        relations
          .filter((relation) => relation.kind === 'replacedBy')
          .map((relation) => relation.observedAt),
      );
      const statusTime = timestamp(record.statusObservedAt ?? record.observedAt);
      const newerRelation =
        statusTime === null ||
        replacementRelation.time === null ||
        replacementRelation.time > statusTime;
      const noDeclaredState = declaredStatus === 'unknown';
      if (noDeclaredState || newerRelation) {
        status = 'discontinued';
        statusReason = 'replaced';
        supersededAt = replacementRelation.value ?? record.observedAt ?? null;
      }
    }

    Object.assign(record, {
      status,
      statusReason,
      statusObservedAt: record.statusObservedAt ?? record.observedAt ?? null,
      orderable: status === 'orderable',
      discontinued: status === 'discontinued',
      replacedBy,
      replaces,
      relations,
      supersededAt,
      firstSeenAt: record.firstSeenAt ?? record.observedAt ?? null,
      lastSeenAt: record.lastSeenAt ?? record.observedAt ?? null,
    });
    return record;
  }

  #rememberRelationEvents(record) {
    for (const relation of record.relations ?? []) {
      const event = {
        source: record.source,
        from: record.id,
        kind: relation.kind,
        to: relation.target,
        derived: relation.derived === true,
        observedAt: relation.observedAt ?? record.observedAt ?? null,
        revision: relation.revision ?? record.revision ?? 0,
      };
      const key = [event.source, event.from, event.kind, event.to, event.observedAt, event.revision].join('|');
      if (this.#eventKeys.has(key)) continue;
      this.#eventKeys.add(key);
      this.#relations.push(event);
    }
  }

  list() {
    return [...this.#records.values()].map(clone);
  }

  get(source, id) {
    const record = this.#records.get(`${source}:${id}`);
    return record ? clone(record) : undefined;
  }

  /** 型号关系的事件流水，按首次出现顺序保留，包含来源时间和修订号。 */
  relationLog() {
    return this.#relations.map(clone);
  }
}
