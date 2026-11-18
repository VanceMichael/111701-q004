import { normalizePage } from './adapter.mjs';
import { queryCatalog } from './catalog.mjs';
import { readSource } from './source.mjs';
import { RecordStore } from './store.mjs';

export async function collect({ source = readSource, store = new RecordStore() } = {}) {
  const page = await source();
  const records = normalizePage(page).map((record) => store.save(record));
  return {
    source: page.source,
    observedAt: page.observedAt ?? null,
    records,
    store,
    catalog: queryCatalog(store, { source: page.source }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await collect();
  console.log(
    JSON.stringify(
      {
        source: result.source,
        count: result.records.length,
        orderable: result.catalog.orderable,
        discontinued: result.catalog.discontinued,
        replaced: result.catalog.replaced,
      },
      null,
      2,
    ),
  );
}
