import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';

// Organizations with rows in every table that names an organization or a workspace, for the tests
// of the export and the erasure (guide steps 8.1 and 8.2). All as app_system.

/** An organization with one workspace and its owner. */
export interface TestOrganization {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
}

/** Creates an organization with one workspace, its settings and an owner. */
export async function createOrganization(
  client: Client,
  organization: TestOrganization,
  names: { name: string; slug: string; email: string },
): Promise<void> {
  await client.query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, $2, now())`, [
    organization.organizationId,
    names.name,
  ]);
  await client.query(
    `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
     VALUES ($1, $2, $3, $4, 'Europe/Berlin', 'de', now())`,
    [organization.workspaceId, organization.organizationId, names.slug, names.name],
  );
  await client.query(`INSERT INTO workspace_settings (workspace_id, updated_at) VALUES ($1, now())`, [
    organization.workspaceId,
  ]);
  await client.query(
    `INSERT INTO users (id, email, name, email_verified, locale, updated_at)
     VALUES ($1, $2, $3, true, 'de', now())`,
    [organization.ownerId, names.email, `Owner of ${names.name}`],
  );
  await client.query(
    `INSERT INTO membership (id, organization_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'OWNER', now())`,
    [randomUUID(), organization.organizationId, organization.ownerId],
  );
}

/** Rows of the tables the demo seed leaves empty, for one organization and workspace. */
export async function fillOrganization(
  client: Client,
  organizationId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const connection = randomUUID();
  await client.query(
    `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                    access_token_sealed, refresh_token_sealed, session_sealed, updated_at)
     VALUES ($1, $2, 'X', 'API', $3, 'Export Test', '\\x0101'::bytea, '\\x0202'::bytea, '\\x0303'::bytea, now())`,
    [connection, workspaceId, `ext-${connection}`],
  );
  await client.query(
    `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name,
                                 access_token_sealed, updated_at)
     VALUES ($1, $2, $3, 'X', 'PROFILE', $4, 'Export Test', '\\x0404'::bytea, now())`,
    [randomUUID(), workspaceId, connection, `acc-${connection}`],
  );
  await client.query(
    `INSERT INTO invitation (id, organization_id, email, role, token_hash, invited_by_id, expires_at)
     VALUES ($1, $2, $3, 'EDITOR', $4, $5, now() + interval '7 days')`,
    [randomUUID(), organizationId, `invited-${organizationId}@example.test`, `hash-${randomUUID()}`, userId],
  );
  await client.query(
    `INSERT INTO notification (id, user_id, organization_id, workspace_id, type)
     VALUES ($1, $2, $3, $4, 'publish-failed')`,
    [randomUUID(), userId, organizationId, workspaceId],
  );
  await client.query(
    `INSERT INTO feature_flag (id, key, workspace_id, enabled, updated_at)
     VALUES ($1, 'x_browser_enabled', $2, true, now())`,
    [randomUUID(), workspaceId],
  );
  await client.query(
    `INSERT INTO usage_record (id, organization_id, workspace_id, meter, source_type, source_id, quantity, period_start)
     VALUES ($1, $2, $3, 'ai_credits_micros', 'AiGeneration', $4, 9007199254740993, '2026-10-01')`,
    [randomUUID(), organizationId, workspaceId, randomUUID()],
  );
  await client.query(
    `INSERT INTO api_cost_record (id, organization_id, workspace_id, platform, operation, cost_micros, source_type, source_id)
     VALUES ($1, $2, $3, 'X', 'post.create', 15000, 'PublishAttempt', $4)`,
    [randomUUID(), organizationId, workspaceId, randomUUID()],
  );
  const asset = randomUUID();
  await client.query(
    `INSERT INTO media_asset (id, workspace_id, status, file_name, declared_mime_type, declared_size, mime_type,
                              size_bytes, storage_key, updated_at)
     VALUES ($1, $2, 'READY', 'team photo.jpg', 'image/jpeg', 1234, 'image/jpeg', 1234, $3, now())`,
    [asset, workspaceId, `ws/${workspaceId}/assets/${asset}/original`],
  );
  await client.query(
    `INSERT INTO media_rendition (id, workspace_id, asset_id, profile, crop_hash, storage_key, mime_type, width,
                                  height, size_bytes)
     VALUES ($1, $2, $3, 'x-landscape', 'crop', $4, 'image/jpeg', 1600, 900, 1000)`,
    [randomUUID(), workspaceId, asset, `ws/${workspaceId}/assets/${asset}/x-landscape.jpg`],
  );
  const post = randomUUID();
  const variant = randomUUID();
  await client.query(
    `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
    [post, workspaceId],
  );
  await client.query(
    `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, updated_at)
     VALUES ($1, $2, $3, 'X', $4, now())`,
    [variant, workspaceId, post, `x:${variant}`],
  );
  await client.query(
    `INSERT INTO post_media (id, workspace_id, variant_id, asset_id, position, updated_at)
     VALUES ($1, $2, $3, $4, 0, now())`,
    [randomUUID(), workspaceId, variant, asset],
  );
  await client.query(
    `INSERT INTO publish_attempt (id, workspace_id, variant_id, schedule_version, attempt_number, trigger, lease_owner)
     VALUES ($1, $2, $3, 1, 1, 'schedule', 'worker-1')`,
    [randomUUID(), workspaceId, variant],
  );
  const voice = randomUUID();
  await client.query(
    `INSERT INTO brand_voice (id, workspace_id, name, current_version_number, updated_at)
     VALUES ($1, $2, 'Voice', 1, now())`,
    [voice, workspaceId],
  );
  await client.query(
    `INSERT INTO brand_voice_version (id, workspace_id, brand_voice_id, version_number, content, content_hash)
     VALUES ($1, $2, $3, 1, '{"tone": "friendly"}', 'hash')`,
    [randomUUID(), workspaceId, voice],
  );
  await client.query(
    `INSERT INTO post_style (id, workspace_id, key, name, instructions, updated_at)
     VALUES ($1, $2, $3, 'Own style', 'Short sentences.', now())`,
    [randomUUID(), workspaceId, `own-${workspaceId}`],
  );
  await client.query(
    `INSERT INTO idea (id, workspace_id, title, updated_at) VALUES ($1, $2, 'An idea', now())`,
    [randomUUID(), workspaceId],
  );
  await client.query(
    `INSERT INTO ai_generation (id, workspace_id, task, prompt_version, provider, model_requested, effort, input, outcome)
     VALUES ($1, $2, 'GENERATE', 'v1', 'mock', 'mock-model', 'low', '{"topic": "launch"}', 'OK')`,
    [randomUUID(), workspaceId],
  );
  await client.query(
    `INSERT INTO membership_workspace (membership_id, workspace_id, organization_id)
     SELECT id, $2, organization_id FROM membership WHERE organization_id = $1 AND user_id = $3`,
    [organizationId, workspaceId, userId],
  );
  await client.query(
    `INSERT INTO usage_counter (id, organization_id, meter, period_start, updated_at)
     VALUES ($1, $2, 'ai_credits_micros', '2026-10-01', now())`,
    [randomUUID(), organizationId],
  );
  await client.query(
    `INSERT INTO audit_log (id, organization_id, workspace_id, action, target_type)
     VALUES ($1, $2, $3, 'post.created', 'Post')`,
    [randomUUID(), organizationId, workspaceId],
  );
  await client.query(
    `INSERT INTO risk_acknowledgement (id, workspace_id, user_id, subject, text_version, text_hash, locale, accepted_at)
     VALUES ($1, $2, $3, 'x-browser', '1', 'text-hash', 'de', now())`,
    [randomUUID(), workspaceId, userId],
  );
  await client.query(
    `INSERT INTO outbox_event (id, workspace_id, type, payload) VALUES ($1, $2, 'variant.status', '{}')`,
    [randomUUID(), workspaceId],
  );
  await client.query(
    `INSERT INTO gdpr_request (id, organization_id, kind, status, requested_by_id, updated_at)
     VALUES ($1, $2, 'EXPORT', 'COMPLETED', $3, now())`,
    [randomUUID(), organizationId, userId],
  );
}
