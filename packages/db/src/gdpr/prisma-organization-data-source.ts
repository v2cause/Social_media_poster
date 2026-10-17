import type { ExportedMedia, ExportedOrganization, OrganizationDataSource } from '@smp/core';

import { Prisma } from '../generated/prisma/client';
import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The data of an organization for its export (guide step 8.1, ADR 0036), as app_system: every
// table with an organization_id or a workspace_id, the organization itself and the users who are
// its members. Secret columns are never selected. The rows come page by page in the order of the
// primary key, each as JSON from PostgreSQL itself, with times in UTC; a test checks that the
// list covers every table that names an organization or a workspace.

/** Which rows of a table belong to the organization. */
type ExportScope =
  /** The organization itself. */
  | 'self'
  | 'organization'
  | 'workspace'
  /** Tables whose rows name the organization, a workspace of it, or both. */
  | 'organizationOrWorkspace'
  /** The users with a membership in the organization. */
  | 'members';

interface ExportTable {
  name: string;
  scope: ExportScope;
  /** The primary key, the order of the pages. */
  key: readonly { column: string; type: 'uuid' | 'date' }[];
  /** Columns that never leave the database: sealed tokens and sessions, hashes of secrets. */
  omit?: readonly string[];
}

const ID = [{ column: 'id', type: 'uuid' }] as const;

/** The tables of the export in the order of the archive. */
export const EXPORT_TABLES: readonly ExportTable[] = [
  { name: 'organization', scope: 'self', key: ID },
  { name: 'workspace', scope: 'organization', key: ID },
  { name: 'workspace_settings', scope: 'workspace', key: [{ column: 'workspace_id', type: 'uuid' }] },
  // Only what the members see of each other; the platform role and the 2FA state stay out.
  { name: 'users', scope: 'members', key: ID, omit: ['is_platform_admin', 'two_factor_enabled'] },
  { name: 'membership', scope: 'organization', key: ID },
  {
    name: 'membership_workspace',
    scope: 'organization',
    key: [
      { column: 'membership_id', type: 'uuid' },
      { column: 'workspace_id', type: 'uuid' },
    ],
  },
  { name: 'invitation', scope: 'organization', key: ID, omit: ['token_hash'] },
  { name: 'subscription', scope: 'organization', key: ID },
  { name: 'usage_counter', scope: 'organization', key: ID },
  { name: 'usage_record', scope: 'organization', key: ID },
  { name: 'api_cost_record', scope: 'organization', key: ID },
  { name: 'audit_log', scope: 'organization', key: ID },
  { name: 'gdpr_request', scope: 'organization', key: ID },
  { name: 'notification', scope: 'organizationOrWorkspace', key: ID },
  { name: 'feature_flag', scope: 'organizationOrWorkspace', key: ID },
  { name: 'brand_voice', scope: 'workspace', key: ID },
  { name: 'brand_voice_version', scope: 'workspace', key: ID },
  { name: 'post_style', scope: 'workspace', key: ID },
  { name: 'idea', scope: 'workspace', key: ID },
  { name: 'post', scope: 'workspace', key: ID },
  { name: 'post_variant', scope: 'workspace', key: ID },
  { name: 'ai_generation', scope: 'workspace', key: ID },
  { name: 'media_asset', scope: 'workspace', key: ID },
  { name: 'media_rendition', scope: 'workspace', key: ID },
  { name: 'post_media', scope: 'workspace', key: ID },
  {
    name: 'social_connection',
    scope: 'workspace',
    key: ID,
    omit: ['access_token_sealed', 'refresh_token_sealed', 'session_sealed'],
  },
  { name: 'social_account', scope: 'workspace', key: ID, omit: ['access_token_sealed'] },
  { name: 'publish_attempt', scope: 'workspace', key: ID },
  { name: 'metric_snapshot', scope: 'workspace', key: ID },
  { name: 'post_metric_latest', scope: 'workspace', key: [{ column: 'variant_id', type: 'uuid' }] },
  { name: 'account_metric_snapshot', scope: 'workspace', key: ID },
  {
    name: 'analytics_daily',
    scope: 'workspace',
    key: [
      { column: 'social_account_id', type: 'uuid' },
      { column: 'day', type: 'date' },
    ],
  },
  { name: 'risk_acknowledgement', scope: 'workspace', key: ID },
  { name: 'outbox_event', scope: 'workspace', key: ID },
];

const TABLES = new Map(EXPORT_TABLES.map((table) => [table.name, table]));
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_PAGE_SIZE = 500;

/** A quoted identifier from the fixed list above or from the catalog, never from input. */
const identifier = (name: string): Prisma.Sql => {
  if (!IDENTIFIER.test(name)) {
    throw new RangeError(`Not an identifier: ${name}`);
  }
  return Prisma.raw(`"${name}"`);
};

const scopeCondition = (scope: ExportScope, organization: ExportedOrganization): Prisma.Sql => {
  const workspaceIds = organization.workspaces.map((workspace) => workspace.id);
  switch (scope) {
    case 'self':
      return Prisma.sql`t.id = ${organization.id}::uuid`;
    case 'organization':
      return Prisma.sql`t.organization_id = ${organization.id}::uuid`;
    case 'workspace':
      return Prisma.sql`t.workspace_id = ANY(${workspaceIds}::uuid[])`;
    case 'organizationOrWorkspace':
      return Prisma.sql`(t.organization_id = ${organization.id}::uuid OR t.workspace_id = ANY(${workspaceIds}::uuid[]))`;
    case 'members':
      return Prisma.sql`t.id IN (SELECT m.user_id FROM membership m WHERE m.organization_id = ${organization.id}::uuid)`;
  }
};

/** One row as JSON, with its key columns as text for the next page (k0, k1). */
type PageRow = { json: string } & Partial<Record<string, string>>;

export class PrismaOrganizationDataSource implements OrganizationDataSource {
  private columns: Promise<Map<string, string[]>> | null = null;

  constructor(
    private readonly system: SystemPrismaClient,
    private readonly pageSize = DEFAULT_PAGE_SIZE,
  ) {}

  async organization(organizationId: string): Promise<ExportedOrganization | null> {
    const organization = await runInSystemScope(() =>
      this.system.organization.findUnique({
        where: { id: organizationId },
        select: {
          id: true,
          name: true,
          workspaces: { select: { id: true, slug: true, name: true }, orderBy: { createdAt: 'asc' } },
        },
      }),
    );
    return organization;
  }

  tables(): readonly string[] {
    return EXPORT_TABLES.map((table) => table.name);
  }

  async *rows(name: string, organization: ExportedOrganization): AsyncIterable<string> {
    const table = TABLES.get(name);
    if (!table) {
      throw new RangeError(`The table ${name} is not part of the export.`);
    }
    const columns = (await this.columnsOf())
      .get(table.name)
      ?.filter((column) => !table.omit?.includes(column));
    if (!columns || columns.length === 0) {
      throw new Error(`The table ${table.name} has no columns to export.`);
    }
    const selected = Prisma.join(columns.map((column) => Prisma.sql`t.${identifier(column)}`));
    const keys = table.key.map((key) => Prisma.sql`t.${identifier(key.column)}`);
    const keyList = Prisma.join(keys);
    let cursor: string[] | null = null;
    for (;;) {
      const after: Prisma.Sql = cursor
        ? Prisma.sql`AND (${keyList}) > (${Prisma.join(
            table.key.map((key, index) =>
              key.type === 'date'
                ? Prisma.sql`${cursor?.[index] ?? ''}::date`
                : Prisma.sql`${cursor?.[index] ?? ''}::uuid`,
            ),
          )})`
        : Prisma.empty;
      const query = Prisma.sql`
        SELECT row_to_json(r)::text AS json,
               ${Prisma.join(table.key.map((key, index) => Prisma.sql`r.${identifier(key.column)}::text AS ${identifier(`k${String(index)}`)}`))}
          FROM (SELECT ${selected}
                  FROM ${identifier(table.name)} t
                 WHERE ${scopeCondition(table.scope, organization)} ${after}
                 ORDER BY ${keyList}
                 LIMIT ${this.pageSize}) r
         ORDER BY ${Prisma.join(table.key.map((key) => Prisma.sql`r.${identifier(key.column)}`))}`;
      const page = await runInSystemScope(() =>
        this.system.$transaction(async (tx) => {
          // row_to_json writes times in the zone of the session.
          await tx.$executeRaw`SELECT set_config('TimeZone', 'UTC', true)`;
          return tx.$queryRaw<PageRow[]>(query);
        }),
      );
      for (const row of page) {
        yield row.json;
      }
      const last = page.at(-1);
      if (!last || page.length < this.pageSize) {
        return;
      }
      cursor = table.key.map((_key, index) => last[`k${String(index)}`] ?? '');
    }
  }

  async *media(organization: ExportedOrganization): AsyncIterable<ExportedMedia> {
    const slugs = new Map(organization.workspaces.map((workspace) => [workspace.id, workspace.slug]));
    const workspaceIds = [...slugs.keys()];
    let after: string | undefined;
    for (;;) {
      const page = await runInSystemScope(() =>
        this.system.mediaAsset.findMany({
          where: { workspaceId: { in: workspaceIds }, ...(after ? { id: { gt: after } } : {}) },
          orderBy: { id: 'asc' },
          take: this.pageSize,
          select: { id: true, workspaceId: true, fileName: true, storageKey: true },
        }),
      );
      for (const asset of page) {
        yield {
          workspaceSlug: slugs.get(asset.workspaceId) ?? asset.workspaceId,
          assetId: asset.id,
          fileName: asset.fileName,
          storageKey: asset.storageKey,
        };
      }
      after = page.at(-1)?.id;
      if (!after || page.length < this.pageSize) {
        return;
      }
    }
  }

  /** The columns of every exported table in their order, read once from the catalog. */
  private columnsOf(): Promise<Map<string, string[]>> {
    this.columns ??= runInSystemScope(async () => {
      const rows = await this.system.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ANY(${[...TABLES.keys()]}::text[])
         ORDER BY table_name, ordinal_position`;
      const columns = new Map<string, string[]>();
      for (const row of rows) {
        columns.set(row.table_name, [...(columns.get(row.table_name) ?? []), row.column_name]);
      }
      return columns;
    }).catch((error: unknown) => {
      // The next export asks the catalog again.
      this.columns = null;
      throw error;
    });
    return this.columns;
  }
}
