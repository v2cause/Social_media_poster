import {
  uuidV7Ids,
  type IdGenerator,
  type PublishJobScope,
  type PublishJobStore,
  type PublishJobTarget,
  type PublishJobUnitOfWork,
  type SocialConnection,
  type UnclearAttempt,
} from '@smp/core';
import { Pool, type PoolClient } from 'pg';

import { toCrop } from '../media/mappers';
import { accountSettingsOf, toPublishJobVariant, type LockedVariantRow } from './publish-job-rows';

// The store of the publish job on node-postgres (guide step 8.5, ADR 0040): the repositories of
// createPrismaPublishJobStore as named prepared statements, which Postgres parses and plans once
// per connection. The database work of a run costs about a third of the CPU it costs through the
// Prisma client. A unit is one transaction as app_user with the tenant of the job set at its
// start, transaction-local like setTenantContext, so row-level security applies as before; every
// statement filters by the workspace explicitly as well. Ids are UUIDv7, like the defaults of
// the Prisma schema, and updated_at is set where Prisma sets it.

/** A statement Postgres prepares under its name on each connection. */
interface Statement {
  readonly name: string;
  readonly text: string;
}

const statement = (name: string, text: string): Statement => ({ name: `publish_job_${name}`, text });

const SQL = {
  tenant: statement(
    'tenant',
    `SELECT set_config('app.user_id', '', true), set_config('app.organization_id', $1, true),
            set_config('app.workspace_id', $2, true), set_config('app.invitation_token_hash', '', true)`,
  ),
  // The row lock lasts until the end of the transaction: claims of the same variant wait.
  lockVariant: statement(
    'lock_variant',
    `SELECT v.id, v.workspace_id, v.post_id, v.platform, v.status, v.version, v.schedule_version,
            v.social_account_id, v.text, v.hashtags, v.first_comment, v.link_url, v.scheduled_at,
            v.queued_at, v.lease_owner, v.lease_until, s.dry_run, s.missed_window_behavior
       FROM post_variant v
       LEFT JOIN workspace_settings s ON s.workspace_id = v.workspace_id
      WHERE v.id = $2 AND v.workspace_id = $1
        FOR UPDATE OF v`,
  ),
  claim: statement(
    'claim',
    `UPDATE post_variant
        SET status = 'PUBLISHING', lease_owner = $4, lease_until = $5, version = version + 1, updated_at = now()
      WHERE id = $2 AND workspace_id = $1 AND version = $3`,
  ),
  extendLease: statement(
    'extend_lease',
    `UPDATE post_variant
        SET lease_until = $5, version = version + 1, updated_at = now()
      WHERE id = $2 AND workspace_id = $1 AND version = $3 AND lease_owner = $4 AND status = 'PUBLISHING'`,
  ),
  finishPublished: statement(
    'finish_published',
    `UPDATE post_variant
        SET status = 'PUBLISHED', published_at = $5, external_post_id = $6, external_url = $7,
            content_hash = $8, is_dry_run = $9, metrics_next_at = $10, metrics_step = 0,
            failure_code = NULL, last_error = NULL, lease_owner = NULL, lease_until = NULL,
            version = version + 1, updated_at = now()
      WHERE id = $2 AND workspace_id = $1 AND version = $3 AND lease_owner = $4 AND status = 'PUBLISHING'`,
  ),
  finishUnpublished: statement(
    'finish_unpublished',
    `UPDATE post_variant
        SET status = $5, failure_code = $6, last_error = $7, lease_owner = NULL, lease_until = NULL,
            version = version + 1, updated_at = now()
      WHERE id = $2 AND workspace_id = $1 AND version = $3 AND lease_owner = $4 AND status = 'PUBLISHING'`,
  ),
  fail: statement(
    'fail',
    `UPDATE post_variant
        SET status = 'FAILED', failure_code = $4, last_error = NULL, lease_owner = NULL, lease_until = NULL,
            version = version + 1, updated_at = now()
      WHERE id = $2 AND workspace_id = $1 AND version = $3`,
  ),
  unclearAttempts: statement(
    'unclear_attempts',
    `SELECT schedule_version, outcome, started_at
       FROM publish_attempt
      WHERE workspace_id = $1 AND variant_id = $2 AND outcome IN ('STARTED', 'UNKNOWN')
      ORDER BY started_at`,
  ),
  // The next number of the schedule version and the row in one statement; the claim holds the
  // row lock of the variant, so no other run counts meanwhile.
  startAttempt: statement(
    'start_attempt',
    `INSERT INTO publish_attempt
            (id, workspace_id, variant_id, schedule_version, attempt_number, trigger, lease_owner, started_at)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::int, COALESCE(MAX(attempt_number), 0) + 1, $5::text, $6::text,
            $7::timestamptz
       FROM publish_attempt
      WHERE workspace_id = $2::uuid AND variant_id = $3::uuid AND schedule_version = $4::int
     RETURNING attempt_number`,
  ),
  markSent: statement(
    'mark_sent',
    `UPDATE publish_attempt SET outcome = 'UNKNOWN' WHERE id = $2 AND workspace_id = $1`,
  ),
  finishAttempt: statement(
    'finish_attempt',
    `UPDATE publish_attempt
        SET outcome = $3, error_code = $4, error_message = $5, external_post_id = $6, meta = $7::jsonb,
            finished_at = $8
      WHERE id = $2 AND workspace_id = $1`,
  ),
  target: statement(
    'target',
    `SELECT a.id, a.workspace_id, a.connection_id, a.platform, a.type, a.external_id, a.name, a.handle,
            a.settings, a.disconnected_at, a.access_token_sealed AS account_token_sealed,
            c.platform AS connection_platform, c.method, c.status, c.external_user_id, c.display_name,
            c.access_token_sealed, c.refresh_token_sealed, c.session_sealed, c.access_token_expires_at,
            c.refresh_token_expires_at, c.scopes, c.version
       FROM social_account a
       JOIN social_connection c ON c.id = a.connection_id AND c.workspace_id = $1
      WHERE a.id = $2 AND a.workspace_id = $1`,
  ),
  connection: statement(
    'connection',
    `SELECT id AS connection_id, workspace_id, platform AS connection_platform, method, status,
            external_user_id, display_name, access_token_sealed, refresh_token_sealed, session_sealed,
            access_token_expires_at, refresh_token_expires_at, scopes, version
       FROM social_connection
      WHERE id = $2 AND workspace_id = $1`,
  ),
  storeRefresh: statement(
    'store_refresh',
    `UPDATE social_connection
        SET access_token_sealed = $4, access_token_expires_at = $5, refresh_token_sealed = $6,
            refresh_token_expires_at = $7, scopes = $8, last_refreshed_at = $9, version = version + 1,
            updated_at = now()
      WHERE id = $2 AND workspace_id = $1 AND version = $3`,
  ),
  // Like markNeedsReauth of the token maintenance: from ACTIVE or EXPIRING only, and the
  // scheduled variants of its accounts carry REAUTH_REQUIRED as a mark, keeping their status.
  needsReauth: statement(
    'needs_reauth',
    `UPDATE social_connection
        SET status = 'NEEDS_REAUTH', status_reason = $3, version = version + 1, updated_at = now()
      WHERE id = $2 AND workspace_id = $1 AND status IN ('ACTIVE', 'EXPIRING')`,
  ),
  markReauthVariants: statement(
    'mark_reauth_variants',
    `UPDATE post_variant
        SET failure_code = 'REAUTH_REQUIRED', updated_at = now()
      WHERE workspace_id = $1 AND status = 'SCHEDULED'
        AND social_account_id IN (SELECT id FROM social_account WHERE workspace_id = $1 AND connection_id = $2)`,
  ),
  mediaItems: statement(
    'media_items',
    `SELECT m.asset_id, m.crop, m.letterbox, m.alt_text, a.alt_text AS asset_alt_text
       FROM post_media m
       JOIN media_asset a ON a.id = m.asset_id AND a.workspace_id = $1
      WHERE m.variant_id = $2 AND m.workspace_id = $1
      ORDER BY m.position`,
  ),
  rendition: statement(
    'rendition',
    `SELECT storage_key, mime_type, width, height, size_bytes
       FROM media_rendition
      WHERE workspace_id = $1 AND asset_id = $2 AND profile = $3 AND crop_hash = $4
      LIMIT 1`,
  ),
  // Booked once per source and operation, like the usage ledger.
  recordCosts: statement(
    'record_costs',
    `INSERT INTO api_cost_record
            (id, organization_id, workspace_id, social_account_id, platform, operation, units, cost_micros,
             source_type, source_id)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::"Platform"[], $6::text[],
                          $7::int[], $8::bigint[], $9::text[], $10::uuid[])
     ON CONFLICT DO NOTHING`,
  ),
  addOutboxEvent: statement(
    'add_outbox_event',
    `INSERT INTO outbox_event (id, workspace_id, type, payload) VALUES ($1, $2, $3, $4::jsonb)`,
  ),
} as const;

/** The connection as both reads select it. */
interface ConnectionRow {
  connection_id: string;
  workspace_id: string;
  connection_platform: SocialConnection['platform'];
  method: SocialConnection['method'];
  status: SocialConnection['status'];
  external_user_id: string;
  display_name: string;
  access_token_sealed: Uint8Array | null;
  refresh_token_sealed: Uint8Array | null;
  session_sealed: Uint8Array | null;
  access_token_expires_at: Date | null;
  refresh_token_expires_at: Date | null;
  scopes: string[];
  version: number;
}

interface TargetRow extends ConnectionRow {
  id: string;
  platform: PublishJobTarget['account']['platform'];
  type: PublishJobTarget['account']['type'];
  external_id: string;
  name: string;
  handle: string | null;
  settings: unknown;
  disconnected_at: Date | null;
  account_token_sealed: Uint8Array | null;
}

interface UnclearRow {
  schedule_version: number;
  outcome: string;
  started_at: Date;
}

interface MediaItemRow {
  asset_id: string;
  crop: unknown;
  letterbox: boolean;
  alt_text: string | null;
  asset_alt_text: string | null;
}

interface RenditionRow {
  storage_key: string;
  mime_type: string;
  width: number;
  height: number;
  size_bytes: number;
}

/** A copy in a buffer of its own: node-postgres hands out slices of a shared one. */
const bytes = (value: Uint8Array | null): Uint8Array | null =>
  value === null ? null : new Uint8Array(value);

const toConnection = (row: ConnectionRow): SocialConnection => ({
  id: row.connection_id,
  workspaceId: row.workspace_id,
  platform: row.connection_platform,
  method: row.method,
  status: row.status,
  externalUserId: row.external_user_id,
  displayName: row.display_name,
  accessTokenSealed: bytes(row.access_token_sealed),
  refreshTokenSealed: bytes(row.refresh_token_sealed),
  sessionSealed: bytes(row.session_sealed),
  accessTokenExpiresAt: row.access_token_expires_at,
  refreshTokenExpiresAt: row.refresh_token_expires_at,
  scopes: row.scopes,
  version: row.version,
});

export function createPgPublishJobStore(client: PoolClient, ids: IdGenerator = uuidV7Ids): PublishJobStore {
  const rows = async <R>(sql: Statement, values: unknown[]): Promise<R[]> =>
    (await client.query({ name: sql.name, text: sql.text, values })).rows as R[];
  const changed = async (sql: Statement, values: unknown[]): Promise<number> =>
    (await client.query({ name: sql.name, text: sql.text, values })).rowCount ?? 0;

  return {
    variants: {
      async lockForJob(workspaceId, variantId) {
        const [row] = await rows<LockedVariantRow>(SQL.lockVariant, [workspaceId, variantId]);
        return row ? toPublishJobVariant(row) : null;
      },
      async claim(workspaceId, variantId, version, lease) {
        const count = await changed(SQL.claim, [workspaceId, variantId, version, lease.owner, lease.until]);
        return count === 1 ? version + 1 : null;
      },
      async extendLease(workspaceId, variantId, version, lease) {
        const count = await changed(SQL.extendLease, [
          workspaceId,
          variantId,
          version,
          lease.owner,
          lease.until,
        ]);
        return count === 1 ? version + 1 : null;
      },
      async finish(workspaceId, variantId, version, owner, result) {
        const count =
          result.status === 'PUBLISHED'
            ? await changed(SQL.finishPublished, [
                workspaceId,
                variantId,
                version,
                owner,
                result.publishedAt,
                result.externalPostId,
                result.externalUrl,
                result.contentHash,
                result.isDryRun,
                result.metricsNextAt,
              ])
            : await changed(SQL.finishUnpublished, [
                workspaceId,
                variantId,
                version,
                owner,
                result.status,
                result.failureCode,
                result.lastError,
              ]);
        return count === 1;
      },
      async fail(workspaceId, variantId, version, failureCode) {
        return (await changed(SQL.fail, [workspaceId, variantId, version, failureCode])) === 1;
      },
    },

    attempts: {
      async unclear(workspaceId, variantId) {
        const found = await rows<UnclearRow>(SQL.unclearAttempts, [workspaceId, variantId]);
        return found.flatMap(({ schedule_version, outcome, started_at }): UnclearAttempt[] =>
          outcome === 'STARTED' || outcome === 'UNKNOWN'
            ? [{ scheduleVersion: schedule_version, outcome, startedAt: started_at }]
            : [],
        );
      },
      async start(attempt) {
        const [row] = await rows<{ attempt_number: number }>(SQL.startAttempt, [
          attempt.id,
          attempt.workspaceId,
          attempt.variantId,
          attempt.scheduleVersion,
          attempt.trigger,
          attempt.leaseOwner,
          attempt.startedAt,
        ]);
        if (!row) {
          throw new Error('The publish attempt was not written.');
        }
        return row.attempt_number;
      },
      async markSent(workspaceId, attemptId) {
        await changed(SQL.markSent, [workspaceId, attemptId]);
      },
      async finish(workspaceId, attemptId, result) {
        await changed(SQL.finishAttempt, [
          workspaceId,
          attemptId,
          result.outcome,
          result.errorCode,
          result.errorMessage,
          result.externalPostId,
          // A plain JSON copy: drops undefined values and fails on what JSON cannot hold.
          JSON.stringify(result.meta),
          result.finishedAt,
        ]);
      },
    },

    targets: {
      async find(workspaceId, accountId) {
        const [row] = await rows<TargetRow>(SQL.target, [workspaceId, accountId]);
        return row
          ? {
              account: {
                id: row.id,
                workspaceId: row.workspace_id,
                connectionId: row.connection_id,
                platform: row.platform,
                type: row.type,
                externalId: row.external_id,
                name: row.name,
                handle: row.handle,
                settings: accountSettingsOf(row.settings),
              },
              disconnectedAt: row.disconnected_at,
              accessTokenSealed: bytes(row.account_token_sealed),
              connection: toConnection(row),
            }
          : null;
      },
    },

    connections: {
      async find(workspaceId, connectionId) {
        const [row] = await rows<ConnectionRow>(SQL.connection, [workspaceId, connectionId]);
        return row ? toConnection(row) : null;
      },
      async storeRefresh(workspaceId, connectionId, version, tokens) {
        const count = await changed(SQL.storeRefresh, [
          workspaceId,
          connectionId,
          version,
          tokens.accessTokenSealed,
          tokens.accessTokenExpiresAt,
          tokens.refreshTokenSealed,
          tokens.refreshTokenExpiresAt,
          tokens.scopes,
          tokens.refreshedAt,
        ]);
        return count === 1;
      },
      async markNeedsReauth(workspaceId, connectionId, reason) {
        if ((await changed(SQL.needsReauth, [workspaceId, connectionId, reason])) === 0) {
          return { changed: false, scheduledVariants: 0 };
        }
        return {
          changed: true,
          scheduledVariants: await changed(SQL.markReauthVariants, [workspaceId, connectionId]),
        };
      },
    },

    media: {
      async itemsOf(workspaceId, variantId) {
        const found = await rows<MediaItemRow>(SQL.mediaItems, [workspaceId, variantId]);
        return found.map((row) => ({
          assetId: row.asset_id,
          crop: toCrop(row.crop),
          letterbox: row.letterbox,
          altText: row.alt_text ?? row.asset_alt_text,
        }));
      },
      async rendition(workspaceId, assetId, profile, cropHash) {
        const [row] = await rows<RenditionRow>(SQL.rendition, [workspaceId, assetId, profile, cropHash]);
        return row
          ? {
              storageKey: row.storage_key,
              mimeType: row.mime_type,
              width: row.width,
              height: row.height,
              sizeBytes: row.size_bytes,
            }
          : null;
      },
    },

    costs: {
      async record(entries) {
        if (entries.length === 0) {
          return;
        }
        await changed(SQL.recordCosts, [
          entries.map(() => ids.newId()),
          entries.map((entry) => entry.organizationId),
          entries.map((entry) => entry.workspaceId),
          entries.map((entry) => entry.socialAccountId),
          entries.map((entry) => entry.platform),
          entries.map((entry) => entry.operation),
          entries.map((entry) => entry.units),
          entries.map((entry) => entry.costMicros),
          entries.map((entry) => entry.sourceType),
          entries.map((entry) => entry.sourceId),
        ]);
      },
    },

    outbox: {
      async add(workspaceId, event) {
        await changed(SQL.addOutboxEvent, [
          ids.newId(),
          workspaceId,
          event.type,
          JSON.stringify(event.payload),
        ]);
      },
    },
  };
}

export interface PublishJobPoolOptions {
  /** At most this many connections; a run holds one only during its transactions. */
  max: number;
  /** An idle connection broke, for example when Postgres restarted; the pool opens a new one. */
  onError: (error: Error) => void;
}

export type PublishJobPool = Pool;

/** The connections of the publish job as app_user. Pass DATABASE_URL. */
export function createPublishJobPool(
  connectionString: string,
  options: PublishJobPoolOptions,
): PublishJobPool {
  const pool = new Pool({
    connectionString,
    max: options.max,
    // A connection, a statement or a transaction that hangs fails the run instead of blocking it.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 10_000,
  });
  pool.on('error', options.onError);
  return pool;
}

export class PgPublishJobUnitOfWork implements PublishJobUnitOfWork {
  constructor(
    private readonly pool: PublishJobPool,
    private readonly ids: IdGenerator = uuidV7Ids,
  ) {}

  async run<T>(scope: PublishJobScope, work: (store: PublishJobStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // A connection whose rollback failed is in an unknown state and leaves the pool.
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query({ ...SQL.tenant, values: [scope.organizationId, scope.workspaceId] });
      const result = await work(createPgPublishJobStore(client, this.ids));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch((rollback: unknown) => {
        broken = rollback instanceof Error ? rollback : new Error('The rollback failed.');
      });
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
