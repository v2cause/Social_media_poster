import { describe, expect, it } from 'vitest';

import {
  DisableXBrowser,
  EnableXBrowser,
  GetXBrowserAdmin,
  GetXBrowserStatus,
  NotPermittedError,
  OrganizationNotFoundError,
  RiskTextOutdatedError,
  SetXBrowserKillSwitch,
  SetXBrowserOrganization,
  StoreBrowserSession,
  WorkspaceNotFoundError,
  XBrowserGate,
  XBrowserUnavailableError,
  xBrowserBlocks,
  type ContentActor,
  type RiskText,
} from '../../src';
import { fixedClock, sequentialIds } from '../in-memory-content';
import { InMemoryXBrowser, RecordingKillSignal } from '../in-memory-x-browser';

// Guide step 6.1: the X browser opens only when the deployment offers it, the kill switch is
// off, the organization may use it, the workspace switched it on and the current risk text is
// acknowledged.

const owner: ContentActor = {
  userId: 'user-owner',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  role: 'OWNER',
};
const editor: ContentActor = { ...owner, userId: 'user-editor', role: 'EDITOR' };

const riskText = (version = '2026-10-17'): RiskText => ({
  version,
  hashOf: (locale) => (locale === 'de' || locale === 'en' ? `hash-${locale}-${version}` : null),
});

function setup(options: { offered?: boolean; version?: string } = {}) {
  const unitOfWork = new InMemoryXBrowser();
  unitOfWork.names.set(owner.userId, 'Olga Owner');
  unitOfWork.directory.set('org-1', { id: 'org-1', name: 'Demo GmbH' });
  unitOfWork.workspaceSlugs.set('demo', { id: 'org-1', name: 'Demo GmbH' });
  const clock = fixedClock('2026-10-17T08:00:00Z');
  const deps = {
    unitOfWork,
    offered: options.offered ?? true,
    riskText: riskText(options.version),
    clock,
    ids: sequentialIds('ack'),
  };
  const killSignal = new RecordingKillSignal();
  const admin = { store: unitOfWork.admin(() => clock.now()), killSignal, offered: deps.offered };
  return { unitOfWork, deps, admin, killSignal };
}

const enable = (deps: ReturnType<typeof setup>['deps'], actor = owner, version = '2026-10-17') =>
  new EnableXBrowser(deps).execute({ actor, version, locale: 'de', ipAddress: '203.0.113.7' });

describe('xBrowserBlocks', () => {
  it('names every condition that does not hold, in a fixed order', () => {
    const flags = { global: null, organization: null, workspace: null };
    expect(
      xBrowserBlocks({
        offered: false,
        flags,
        planAllows: false,
        acknowledgedVersion: null,
        currentVersion: 'v2',
      }),
    ).toEqual(['deployment', 'plan', 'workspace', 'acknowledgement']);
    expect(
      xBrowserBlocks({
        offered: true,
        flags: { global: false, organization: true, workspace: true },
        planAllows: false,
        acknowledgedVersion: 'v1',
        currentVersion: 'v2',
      }),
    ).toEqual(['kill_switch', 'acknowledgement']);
    expect(
      xBrowserBlocks({
        offered: true,
        flags: { global: true, organization: true, workspace: true },
        planAllows: false,
        acknowledgedVersion: 'v2',
        currentVersion: 'v2',
      }),
    ).toEqual([]);
    // A plan with the X browser needs no switch of the platform admins (guide step 7.4).
    expect(
      xBrowserBlocks({
        offered: true,
        flags: { global: null, organization: null, workspace: true },
        planAllows: true,
        acknowledgedVersion: 'v2',
        currentVersion: 'v2',
      }),
    ).toEqual([]);
  });
});

describe('switching the X browser on and off', () => {
  it('opens for an organization whose plan includes it, without the platform admins', async () => {
    const { deps, unitOfWork } = setup();
    unitOfWork.plansWithXBrowser.add('org-1');

    expect((await new GetXBrowserStatus(deps).execute(owner)).blocks).toEqual([
      'workspace',
      'acknowledgement',
    ]);
    await expect(enable(deps)).resolves.toMatchObject({ available: true, blocks: [] });
  });

  it('stays closed until the organization may use it, then opens with the acknowledgement', async () => {
    const { deps, admin, unitOfWork } = setup();
    const status = new GetXBrowserStatus(deps);
    expect((await status.execute(owner)).blocks).toEqual(['plan', 'workspace', 'acknowledgement']);
    await expect(enable(deps)).rejects.toBeInstanceOf(XBrowserUnavailableError);
    expect(unitOfWork.state.acknowledgements).toEqual([]);

    await new SetXBrowserOrganization(admin).allow('demo');
    const enabled = await enable(deps);
    expect(enabled).toMatchObject({
      available: true,
      blocks: [],
      enabled: true,
      currentVersion: '2026-10-17',
    });
    expect(enabled.acknowledgement).toMatchObject({
      userId: owner.userId,
      userName: 'Olga Owner',
      textVersion: '2026-10-17',
      textHash: 'hash-de-2026-10-17',
      locale: 'de',
      acceptedAt: new Date('2026-10-17T08:00:00Z'),
    });
    expect(unitOfWork.state.acknowledgements[0]).toMatchObject({
      ipAddress: '203.0.113.7',
      subject: 'x_browser',
    });
    expect(unitOfWork.state.audit).toEqual([
      {
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        action: 'x_browser.enable',
        targetType: 'Workspace',
        targetId: 'ws-1',
        metadata: { textVersion: '2026-10-17', locale: 'de' },
      },
    ]);
    await expect(
      new XBrowserGate(deps).allows({ organizationId: 'org-1', workspaceId: 'ws-1' }),
    ).resolves.toBe(true);
  });

  it('needs an owner or admin and the current version of the text', async () => {
    const { deps, admin } = setup();
    await new SetXBrowserOrganization(admin).allow('demo');
    await expect(enable(deps, editor)).rejects.toBeInstanceOf(NotPermittedError);
    await expect(enable(deps, owner, '2026-01-01')).rejects.toBeInstanceOf(RiskTextOutdatedError);
    await expect(
      new EnableXBrowser(deps).execute({
        actor: owner,
        version: '2026-10-17',
        locale: 'fr',
        ipAddress: null,
      }),
    ).rejects.toBeInstanceOf(RiskTextOutdatedError);
  });

  it('asks again after a new version of the text and after switching off', async () => {
    const { deps, admin, unitOfWork } = setup();
    await new SetXBrowserOrganization(admin).allow('demo');
    await enable(deps);

    const newer = { ...deps, riskText: riskText('2026-12-01') };
    expect(await new GetXBrowserStatus(newer).execute(owner)).toMatchObject({
      available: false,
      blocks: ['acknowledgement'],
      enabled: true,
      currentVersion: '2026-12-01',
      acknowledgement: { textVersion: '2026-10-17' },
    });
    await expect(new XBrowserGate(newer).allows(owner)).resolves.toBe(false);
    const again = await enable(newer, owner, '2026-12-01');
    expect(again.available).toBe(true);
    // The older acknowledgement is revoked, the record stays.
    expect(unitOfWork.state.acknowledgements.map((row) => row.revokedAt === null)).toEqual([false, true]);

    const off = await new DisableXBrowser(newer).execute(owner);
    expect(off).toMatchObject({ available: false, enabled: false, acknowledgement: null });
    expect(off.blocks).toEqual(['workspace', 'acknowledgement']);
    expect(unitOfWork.state.audit.at(-1)).toMatchObject({
      action: 'x_browser.disable',
      metadata: { revokedAcknowledgements: 1 },
    });
    await expect(new DisableXBrowser(newer).execute(editor)).rejects.toBeInstanceOf(NotPermittedError);
  });

  it('keeps the gate closed without the deployment and while the kill switch is on', async () => {
    const { deps, admin, killSignal } = setup();
    await new SetXBrowserOrganization(admin).allow('demo');
    await enable(deps);
    const gate = new XBrowserGate(deps);

    await expect(new SetXBrowserKillSwitch(admin).execute(true)).resolves.toBe(true);
    await expect(new SetXBrowserKillSwitch(admin).execute(true)).resolves.toBe(false);
    expect(killSignal.signals).toEqual([true, true]);
    await expect(gate.allows(owner)).resolves.toBe(false);
    expect((await new GetXBrowserStatus(deps).execute(owner)).blocks).toEqual(['kill_switch']);
    await expect(enable(deps)).rejects.toBeInstanceOf(XBrowserUnavailableError);

    await new SetXBrowserKillSwitch(admin).execute(false);
    await expect(gate.allows(owner)).resolves.toBe(true);

    const notOffered = { ...deps, offered: false };
    await expect(new XBrowserGate(notOffered).allows(owner)).resolves.toBe(false);
  });

  it('shows the platform admins the kill switch and the allowed organizations', async () => {
    const { admin } = setup();
    expect(await new GetXBrowserAdmin(admin).execute()).toEqual({
      offered: true,
      killSwitch: { active: false, updatedAt: null },
      organizations: [],
    });
    await new SetXBrowserOrganization(admin).allow('demo');
    await new SetXBrowserKillSwitch(admin).execute(true);
    expect(await new GetXBrowserAdmin(admin).execute()).toEqual({
      offered: true,
      killSwitch: { active: true, updatedAt: new Date('2026-10-17T08:00:00Z') },
      organizations: [{ id: 'org-1', name: 'Demo GmbH', updatedAt: new Date('2026-10-17T08:00:00Z') }],
    });
    await new SetXBrowserOrganization(admin).disallow('org-1');
    expect((await new GetXBrowserAdmin(admin).execute()).organizations).toEqual([]);
    await expect(new SetXBrowserOrganization(admin).allow('unknown')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
    await expect(new SetXBrowserOrganization(admin).disallow('org-unknown')).rejects.toBeInstanceOf(
      OrganizationNotFoundError,
    );
  });
});

describe('StoreBrowserSession', () => {
  it('replaces the session of its browser connection only', async () => {
    const unitOfWork = new InMemoryXBrowser();
    unitOfWork.state.connections.set('connection-1', {
      workspaceId: 'ws-1',
      externalUserId: '1234567890',
      sessionSealed: Uint8Array.from([1]),
    });
    const store = new StoreBrowserSession({ unitOfWork });
    const input = {
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      connectionId: 'connection-1',
      externalUserId: '1234567890',
      sessionSealed: Uint8Array.from([2, 3]),
    };

    await expect(store.execute(input)).resolves.toBe(true);
    expect(unitOfWork.state.connections.get('connection-1')?.sessionSealed).toEqual(Uint8Array.from([2, 3]));
    // Another X user, or a connection that is gone, keeps what it has.
    await expect(store.execute({ ...input, externalUserId: '999' })).resolves.toBe(false);
    await expect(store.execute({ ...input, connectionId: 'connection-2' })).resolves.toBe(false);
    expect(unitOfWork.state.connections.get('connection-1')?.sessionSealed).toEqual(Uint8Array.from([2, 3]));
  });
});
