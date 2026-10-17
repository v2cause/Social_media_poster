import type { Plan, PlanLimits } from '../domain/plan';
import type { SubscriptionStatus } from '../domain/subscription';

/** The subscription of an organization with its plan, as stored (guide step 7.1). */
export interface Subscription {
  organizationId: string;
  plan: Plan;
  status: SubscriptionStatus;
  /** Single limits the operators set on top of the plan. */
  limitOverrides: Partial<PlanLimits> | null;
  trialEndsAt: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: Date | null;
  readOnlyAt: Date | null;
  /** The start of the paid subscription; usage before it is not billed. */
  billingStartedAt: Date | null;
}

/** Reads the subscription of an organization and the price list. */
export interface SubscriptionReader {
  find(organizationId: string): Promise<Subscription | null>;
  /** The plans in the order of the price list, retired ones included. */
  plans(): Promise<Plan[]>;
}

/** Starts the trial of a new organization in the transaction that creates it. */
export interface TrialStarter {
  startTrial(trial: {
    id: string;
    organizationId: string;
    trialEndsAt: Date;
    readOnlyAt: Date;
  }): Promise<void>;
}
