import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import type { InvitationNotifier } from '../ports/invitation-notifier';
import type { SecretTokens } from '../ports/secret-tokens';
import type { TenancyUnitOfWork } from '../ports/tenancy-store';

/** What the tenancy use cases need from the outside. */
export interface TenancyDependencies {
  unitOfWork: TenancyUnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  tokens: SecretTokens;
  notifier: InvitationNotifier;
}
