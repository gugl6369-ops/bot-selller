import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { AdminInboxRepository } from './admin/inbox-repository.ts';
import { AdminOrderRepository } from './admin/orders-repository.ts';
import { OrderMaterialRepository } from './order-material-repository.ts';

function queryStub(result: { rows?: unknown[]; rowCount?: number } = {}) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const database = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
    },
  } as unknown as Pool;
  return { database, calls };
}

test('reusable materials are selected only with feedback consent from an approved fully published order', async () => {
  const { database, calls } = queryStub({
    rows: [{
      source_order_id: 'source-order',
      source_order_number: '12345678',
      source_business_name: 'Previous business',
      ad_text: 'Previously published text',
      media: [{ kind: 'photo', fileId: 'photo-file', caption: '' }],
      destination: 'https://example.com',
      wishes: null,
    }],
  });
  const repository = new OrderMaterialRepository(database);

  const reusable = await repository.getReusableForOrder('current-order');

  assert.equal(reusable?.sourceOrderNumber, '12345678');
  assert.equal(reusable?.adText, 'Previously published text');
  assert.equal(reusable?.media.length, 1);
  assert.match(calls[0]!.sql, /app_user\.feedback_requests = true/);
  assert.match(calls[0]!.sql, /source_order\.status = 'completed'/);
  assert.match(calls[0]!.sql, /source_material\.status = 'approved'/);
  assert.match(calls[0]!.sql, /NOT \('pending' = ANY\(source_order\.publication_statuses\)\)/);
});

test('reuse copies a validated previous package and marks the new package approved', async () => {
  const { database, calls } = queryStub({ rowCount: 1 });
  const repository = new OrderMaterialRepository(database);

  assert.equal(await repository.reusePublishedMaterials('900001', 'current-order', 'source-order'), true);
  assert.deepEqual(calls[0]!.values, ['900001', 'current-order', 'source-order']);
  assert.match(calls[0]!.sql, /status = 'approved', step = 5/);
  assert.match(calls[0]!.sql, /reused_from_order_id = source_order\.id/);
  assert.match(calls[0]!.sql, /app_user\.feedback_requests = true/);
  assert.match(calls[0]!.sql, /source_order\.user_id = current_order\.user_id/);
});

test('admin material listing and inbox count exclude completed orders', async () => {
  const listing = queryStub();
  await new AdminOrderRepository(listing.database).listMaterialSubmissions();
  assert.match(listing.calls[0]!.sql, /material\.status = 'submitted' AND order_record\.status <> 'completed'/);

  const inbox = queryStub({ rows: [{
    unanswered_questions: '0',
    data_deletion_requests: '0',
    pending_orders: '0',
    pending_payments: '0',
    pending_materials: '0',
  }] });
  await new AdminInboxRepository(inbox.database).getInboxCounts();
  assert.match(inbox.calls[0]!.sql, /material\.status = 'submitted' AND order_record\.status <> 'completed'/);
});
