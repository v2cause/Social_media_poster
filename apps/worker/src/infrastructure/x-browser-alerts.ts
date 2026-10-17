import { toLocale } from '@smp/contracts';
import type { SelectorDrift, XBrowserAlerts } from '@smp/core';
import type { PlatformAdmin } from '@smp/db';
import type { NotificationProducer } from '@smp/queue';

// The alerts of the X browser to the platform admins (guide step 6.5): one email each, in the
// language of the admin, through the queue of the role "notify". Its link leads to the platform
// admin page, where the kill switch is lifted again.

/** The canary names at most this many selectors in its email. */
const NAMED_SELECTORS = 20;

export class EmailXBrowserAlerts implements XBrowserAlerts {
  constructor(
    private readonly deps: {
      admins: { platformAdmins(): Promise<PlatformAdmin[]> };
      notifications: Pick<NotificationProducer, 'dispatchEmail'>;
      /** The platform admin page of the web app. */
      adminUrl: string;
    },
  ) {}

  async breakerOpened(alert: SelectorDrift & { drifts: number }): Promise<void> {
    for (const admin of await this.deps.admins.platformAdmins()) {
      await this.deps.notifications.dispatchEmail(admin.email, {
        template: 'x-browser-breaker',
        locale: toLocale(admin.locale),
        name: admin.name,
        url: this.deps.adminUrl,
        drifts: alert.drifts,
        flow: alert.flow,
        selector: alert.selector,
        selectorsVersion: alert.selectorsVersion,
      });
    }
  }

  async canaryFailed(alert: { missing: readonly string[]; selectorsVersion: string }): Promise<void> {
    for (const admin of await this.deps.admins.platformAdmins()) {
      await this.deps.notifications.dispatchEmail(admin.email, {
        template: 'x-browser-canary',
        locale: toLocale(admin.locale),
        name: admin.name,
        url: this.deps.adminUrl,
        missing: alert.missing.slice(0, NAMED_SELECTORS),
        selectorsVersion: alert.selectorsVersion,
      });
    }
  }
}
