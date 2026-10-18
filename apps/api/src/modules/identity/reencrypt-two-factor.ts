import type { PrismaClient } from '@smp/db';
import { parseEnvelope, type SecretConfig, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

// After a rotation of the keys of Better Auth (docs/runbooks/secret-rotation.md): the TOTP secrets
// and backup codes of the second factor are encrypted again with the current key, so that an
// older key can leave BETTER_AUTH_SECRETS afterwards. A row is written only if it still holds what
// was read; one that changed meanwhile (a backup code was used) waits for the next run. Rows the
// keys cannot open are counted and left alone.

export interface ReencryptReport {
  checked: number;
  reencrypted: number;
  /** Already encrypted with the current key. */
  current: number;
  changedMeanwhile: number;
  failed: number;
}

const BATCH = 200;

const isCurrent = (payload: string, key: SecretConfig): boolean =>
  parseEnvelope(payload)?.version === key.currentVersion;

export async function reencryptTwoFactor(prisma: PrismaClient, key: SecretConfig): Promise<ReencryptReport> {
  const report: ReencryptReport = { checked: 0, reencrypted: 0, current: 0, changedMeanwhile: 0, failed: 0 };
  let afterId: string | null = null;
  for (;;) {
    const rows: { id: string; secret: string; backupCodes: string }[] = await prisma.twoFactor.findMany({
      where: afterId === null ? {} : { id: { gt: afterId } },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { id: true, secret: true, backupCodes: true },
    });
    for (const row of rows) {
      report.checked += 1;
      if (isCurrent(row.secret, key) && isCurrent(row.backupCodes, key)) {
        report.current += 1;
        continue;
      }
      let secret: string;
      let backupCodes: string;
      try {
        secret = await symmetricEncrypt({ key, data: await symmetricDecrypt({ key, data: row.secret }) });
        backupCodes = await symmetricEncrypt({
          key,
          data: await symmetricDecrypt({ key, data: row.backupCodes }),
        });
      } catch {
        report.failed += 1;
        continue;
      }
      const { count } = await prisma.twoFactor.updateMany({
        where: { id: row.id, secret: row.secret, backupCodes: row.backupCodes },
        data: { secret, backupCodes },
      });
      if (count === 1) {
        report.reencrypted += 1;
      } else {
        report.changedMeanwhile += 1;
      }
    }
    if (rows.length < BATCH) {
      return report;
    }
    afterId = rows.at(-1)?.id ?? null;
  }
}
