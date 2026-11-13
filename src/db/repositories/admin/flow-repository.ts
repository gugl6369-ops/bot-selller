import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { AdminFlow, AdminFlowType } from '../../../types/admin.ts';

export class PromotionalBroadcastClaimActiveError extends Error {
  constructor() {
    super('A promotional broadcast is currently sending.');
    this.name = 'PromotionalBroadcastClaimActiveError';
  }
}

export class PromotionalBroadcastDraftChangedError extends Error {
  constructor() {
    super('The promotional broadcast draft changed.');
    this.name = 'PromotionalBroadcastDraftChangedError';
  }
}

export class AdminFlowRepository {
  private readonly database: Pool;

  constructor(database: Pool) {
    this.database = database;
  }

  async getFlow(telegramId: string): Promise<AdminFlow | undefined> {
    const result = await this.database.query<{
      flow_type: AdminFlowType;
      step: number;
      payload: Record<string, string>;
    }>(
      `SELECT flow.flow_type, flow.step, flow.payload
       FROM admin_flows AS flow
       JOIN admins AS admin ON admin.id = flow.admin_id
       WHERE admin.telegram_id = $1 AND admin.is_active = true`,
      [telegramId],
    );
    const row = result.rows[0];
    return row ? { flowType: row.flow_type, step: row.step, payload: row.payload } : undefined;
  }

  async saveFlow(telegramId: string, flow: AdminFlow): Promise<void> {
    const result = await this.database.query(
      `INSERT INTO admin_flows (admin_id, flow_type, step, payload)
       SELECT id, $2, $3, $4::jsonb FROM admins
       WHERE telegram_id = $1 AND is_active = true
       ON CONFLICT (admin_id) DO UPDATE
       SET flow_type = EXCLUDED.flow_type,
           step = EXCLUDED.step,
           payload = EXCLUDED.payload,
           updated_at = now()
       WHERE NOT (admin_flows.flow_type = 'promotional_broadcast' AND admin_flows.step = 2)
       RETURNING admin_flows.admin_id`,
      [telegramId, flow.flowType, flow.step, JSON.stringify(flow.payload)],
    );
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.getFlow(telegramId);
      if (current?.flowType === 'promotional_broadcast' && current.step === 2) {
        throw new PromotionalBroadcastClaimActiveError();
      }
    }
  }

  async savePromotionalDraftFlow(telegramId: string, flow: AdminFlow): Promise<void> {
    const token = flow.payload.draftToken;
    if (flow.flowType !== 'promotional_broadcast' || !token) {
      throw new PromotionalBroadcastDraftChangedError();
    }
    const result = await this.database.query(
      `UPDATE admin_flows AS current_flow
       SET step = $3, payload = $4::jsonb, updated_at = now()
       FROM admins AS admin
       WHERE current_flow.admin_id = admin.id
         AND admin.telegram_id = $1 AND admin.is_active = true
         AND current_flow.flow_type = 'promotional_broadcast'
         AND current_flow.step <> 2
         AND current_flow.payload->>'draftToken' = $2
       RETURNING current_flow.admin_id`,
      [telegramId, token, flow.step, JSON.stringify(flow.payload)],
    );
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.getFlow(telegramId);
      if (current?.flowType === 'promotional_broadcast' && current.step === 2) {
        throw new PromotionalBroadcastClaimActiveError();
      }
      throw new PromotionalBroadcastDraftChangedError();
    }
  }

  async clearPromotionalDraftFlow(telegramId: string, token: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM admin_flows AS flow
       USING admins AS admin
       WHERE flow.admin_id = admin.id
         AND admin.telegram_id = $1
         AND flow.flow_type = 'promotional_broadcast'
         AND flow.step <> 2
         AND flow.payload->>'draftToken' = $2
       RETURNING flow.admin_id`,
      [telegramId, token],
    );
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.getFlow(telegramId);
      if (current?.flowType === 'promotional_broadcast' && current.step === 2) {
        throw new PromotionalBroadcastClaimActiveError();
      }
      throw new PromotionalBroadcastDraftChangedError();
    }
    return true;
  }

  async claimPromotionalBroadcast(telegramId: string, expected: AdminFlow): Promise<string | undefined> {
    // A claimed flow is intentionally not reset after a crash: Telegram sends
    // are not idempotent, so an uncertain process outcome requires inspection.
    const token = randomUUID();
    const claimedPayload = { ...expected.payload, claimToken: token };
    const result = await this.database.query(
      `UPDATE admin_flows AS flow
       SET step = 2, payload = $4::jsonb, updated_at = now()
       FROM admins AS admin
       WHERE flow.admin_id = admin.id
         AND admin.telegram_id = $1 AND admin.is_active = true
         AND flow.flow_type = 'promotional_broadcast'
         AND flow.step = $2
         AND flow.payload = $3::jsonb`,
      [telegramId, expected.step, JSON.stringify(expected.payload), JSON.stringify(claimedPayload)],
    );
    return (result.rowCount ?? 0) === 1 ? token : undefined;
  }

  async clearFlow(telegramId: string): Promise<void> {
    const result = await this.database.query(
      `DELETE FROM admin_flows AS flow
       USING admins AS admin
       WHERE flow.admin_id = admin.id
         AND admin.telegram_id = $1
         AND NOT (flow.flow_type = 'promotional_broadcast' AND flow.step = 2)
       RETURNING flow.admin_id`,
      [telegramId],
    );
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.getFlow(telegramId);
      if (current?.flowType === 'promotional_broadcast' && current.step === 2) {
        throw new PromotionalBroadcastClaimActiveError();
      }
    }
  }

  async clearClaimedPromotionalBroadcast(telegramId: string, token: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM admin_flows AS flow
       USING admins AS admin
       WHERE flow.admin_id = admin.id
         AND admin.telegram_id = $1
         AND flow.flow_type = 'promotional_broadcast'
         AND flow.step = 2
         AND flow.payload->>'claimToken' = $2`,
      [telegramId, token],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
