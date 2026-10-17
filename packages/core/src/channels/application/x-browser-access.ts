import type { ContentActor } from '../../content/domain/types';
import { NotPermittedError } from '../../shared/domain/errors';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import { RiskTextOutdatedError, XBrowserUnavailableError } from '../domain/errors';
import { canManageChannels } from '../domain/rules';
import {
  OUTSIDE_BLOCKS,
  X_BROWSER_RISK_SUBJECT,
  xBrowserBlocks,
  type XBrowserBlock,
} from '../domain/x-browser';
import type {
  RiskAcknowledgement,
  XBrowserScope,
  XBrowserStore,
  XBrowserUnitOfWork,
} from '../ports/x-browser';

// The X browser of a workspace (guide step 6.1): its status, switching it on and off, and the
// gate of the adapter registry. Switching on needs an owner or admin, the current version of
// the risk text and the password again, which the API checks before the call. It stores the
// acknowledgement with version, hash, time, user and IP address, switches the flag of the
// workspace on and writes the audit log, all in one transaction. Switching off revokes the
// acknowledgement; a later switch on needs a new one.

/** The risk text in force, from @smp/contracts. */
export interface RiskText {
  version: string;
  /** The SHA-256 of the text in a language; null for a language without text. */
  hashOf(locale: string): string | null;
}

export interface XBrowserAccessDependencies {
  unitOfWork: XBrowserUnitOfWork;
  /** FEATURE_X_BROWSER_GLOBAL: the deployment runs the browser worker. */
  offered: boolean;
  riskText: RiskText;
  clock: Clock;
  ids: IdGenerator;
}

export interface XBrowserStatus {
  available: boolean;
  blocks: XBrowserBlock[];
  enabled: boolean;
  currentVersion: string;
  acknowledgement: RiskAcknowledgement | null;
}

const scopeOf = (actor: ContentActor): XBrowserScope => ({
  userId: actor.userId,
  organizationId: actor.organizationId,
  workspaceId: actor.workspaceId,
});

async function statusIn(
  deps: Pick<XBrowserAccessDependencies, 'offered' | 'riskText'>,
  store: XBrowserStore,
  scope: XBrowserScope,
): Promise<XBrowserStatus> {
  const flags = await store.flags(scope.organizationId, scope.workspaceId);
  const acknowledgement = await store.acknowledgement(scope.workspaceId, X_BROWSER_RISK_SUBJECT);
  const blocks = xBrowserBlocks({
    offered: deps.offered,
    flags,
    acknowledgedVersion: acknowledgement?.textVersion ?? null,
    currentVersion: deps.riskText.version,
  });
  return {
    available: blocks.length === 0,
    blocks,
    enabled: flags.workspace === true,
    currentVersion: deps.riskText.version,
    acknowledgement,
  };
}

function assertCanSwitch(actor: ContentActor): void {
  if (!canManageChannels(actor.role)) {
    throw new NotPermittedError();
  }
}

export class GetXBrowserStatus {
  constructor(
    private readonly deps: Pick<XBrowserAccessDependencies, 'unitOfWork' | 'offered' | 'riskText'>,
  ) {}

  execute(actor: ContentActor): Promise<XBrowserStatus> {
    const scope = scopeOf(actor);
    return this.deps.unitOfWork.run(scope, (store) => statusIn(this.deps, store, scope));
  }
}

export interface EnableXBrowserInput {
  actor: ContentActor;
  /** The version of the risk text the user read. */
  version: string;
  locale: string;
  ipAddress: string | null;
}

export class EnableXBrowser {
  constructor(private readonly deps: XBrowserAccessDependencies) {}

  async execute(input: EnableXBrowserInput): Promise<XBrowserStatus> {
    const { actor } = input;
    assertCanSwitch(actor);
    const { deps } = this;
    const textHash = deps.riskText.hashOf(input.locale);
    if (input.version !== deps.riskText.version || textHash === null) {
      throw new RiskTextOutdatedError();
    }
    const scope = scopeOf(actor);
    return deps.unitOfWork.run(scope, async (store) => {
      const before = await statusIn(deps, store, scope);
      if (before.blocks.some((block) => OUTSIDE_BLOCKS.includes(block))) {
        throw new XBrowserUnavailableError();
      }
      const now = deps.clock.now();
      // The acknowledgement of an older version makes way for the new one.
      await store.revoke(actor.workspaceId, X_BROWSER_RISK_SUBJECT, now);
      await store.acknowledge({
        id: deps.ids.newId(),
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        subject: X_BROWSER_RISK_SUBJECT,
        textVersion: deps.riskText.version,
        textHash,
        locale: input.locale,
        ipAddress: input.ipAddress,
        acceptedAt: now,
      });
      await store.setWorkspaceFlag(actor.organizationId, actor.workspaceId, true);
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'x_browser.enable',
        targetType: 'Workspace',
        targetId: actor.workspaceId,
        metadata: { textVersion: deps.riskText.version, locale: input.locale },
      });
      return statusIn(deps, store, scope);
    });
  }
}

export class DisableXBrowser {
  constructor(
    private readonly deps: Pick<XBrowserAccessDependencies, 'unitOfWork' | 'offered' | 'riskText' | 'clock'>,
  ) {}

  async execute(actor: ContentActor): Promise<XBrowserStatus> {
    assertCanSwitch(actor);
    const { deps } = this;
    const scope = scopeOf(actor);
    return deps.unitOfWork.run(scope, async (store) => {
      const revoked = await store.revoke(actor.workspaceId, X_BROWSER_RISK_SUBJECT, deps.clock.now());
      await store.setWorkspaceFlag(actor.organizationId, actor.workspaceId, false);
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'x_browser.disable',
        targetType: 'Workspace',
        targetId: actor.workspaceId,
        metadata: { revokedAcknowledgements: revoked },
      });
      return statusIn(deps, store, scope);
    });
  }
}

/** The gate of the adapter registry: open only when every condition holds. */
export class XBrowserGate {
  constructor(
    private readonly deps: Pick<XBrowserAccessDependencies, 'unitOfWork' | 'offered' | 'riskText'>,
  ) {}

  async allows(scope: { organizationId: string; workspaceId: string }): Promise<boolean> {
    if (!this.deps.offered) {
      return false;
    }
    const status = await this.deps.unitOfWork.run(scope, (store) => statusIn(this.deps, store, scope));
    return status.available;
  }
}
