// Domain core: entities, use cases and ports. Framework-free by rule.

// Shared kernel
export { DomainError, isDomainError, NotPermittedError, type DomainErrorKind } from './shared/domain/errors';
export { systemClock, uuidV7Ids } from './shared/adapters/system';
export type { Clock } from './shared/ports/clock';
export type { IdGenerator } from './shared/ports/ids';

// AI (architecture 5)
export {
  AI_EFFORTS,
  AI_FAILURE_CODES,
  AI_ROUTES,
  CONTENT_LANGUAGES,
  EMOJI_POLICIES,
  HASHTAG_POLICIES,
  REFINE_ACTIONS,
  type AiAttempt,
  type AiCallReport,
  type AiEffort,
  type AiFailure,
  type AiFailureCode,
  type AiRoute,
  type AiTarget,
  type BrandContext,
  type BrandProfile,
  type BrandVoiceContent,
  type ContentLanguage,
  type CustomStyle,
  type EmojiPolicy,
  type GeneratedVariant,
  type HashtagPolicy,
  type RefineAction,
  type TopicIdea,
} from './ai/domain/types';
export {
  attemptCostMicros,
  callCostMicros,
  estimateCostMicros,
  type CallCost,
  type ModelPrice,
} from './ai/domain/cost';
export { CostCalculator, type CostCalculatorDependencies } from './ai/application/cost-calculator';
export { AiCallFailedError } from './ai/domain/errors';
export {
  AI_OUTCOMES,
  AI_TASKS,
  type AiGenerationEntry,
  type AiGenerationLog,
  type AiOutcome,
  type AiTask,
} from './ai/ports/ai-generation-log';
export type { AiRequest, AiUsageEstimator, TokenEstimate } from './ai/ports/ai-usage-estimator';
export type { AiDependencies, AiWarn } from './ai/application/ai-dependencies';
export {
  checkContent,
  checkVariant,
  countOf,
  forbiddenWordsIn,
  type GeneratedVariantResult,
  type GenerationEvent,
} from './ai/application/variant-results';
export {
  DEFAULT_STYLE_KEY,
  GenerateVariants,
  type GenerateVariantsCommand,
} from './ai/application/generate-variants';
export { RefineVariant, type RefineVariantCommand } from './ai/application/refine-variant';
export {
  GenerateIdeas,
  type GenerateIdeasCommand,
  type GenerateIdeasResult,
} from './ai/application/generate-ideas';
export {
  SAMPLE_BRIEFS,
  TestBrandVoice,
  type TestBrandVoiceCommand,
  type TestBrandVoiceResult,
} from './ai/application/test-brand-voice';
export type { PriceCatalog } from './ai/ports/price-catalog';
export type {
  AiCallOptions,
  AiProvider,
  AiResult,
  AltTextImage,
  GenerateVariantsInput,
  PartialVariant,
  RefineVariantInput,
  SuggestAltTextInput,
  SuggestTopicsInput,
  VariantStreamEvent,
} from './ai/ports/ai-provider';

// Audit
export { assertSafeAuditMetadata, UnsafeAuditMetadataError } from './audit/domain/audit-metadata';
export type { AuditEntry, AuditTrail } from './audit/ports/audit-trail';

// Content (architecture 6.2)
export * from './content/domain/errors';
export {
  canManageBrand,
  canonicalJson,
  canWriteContent,
  customStyleKey,
  isVariantEditable,
  isVariantInFlight,
  nextTargetKeys,
} from './content/domain/rules';
export {
  IDEA_STATUSES,
  VARIANT_STATUSES,
  type BrandVoice,
  type BrandVoiceVersion,
  type ContentActor,
  type Idea,
  type IdeaStatus,
  type Post,
  type PostStyle,
  type PostVariant,
  type VariantStatus,
} from './content/domain/types';
export type {
  BrandVoicePatch,
  BrandVoiceRepository,
  ContentScope,
  ContentStore,
  ContentUnitOfWork,
  IdeaPatch,
  IdeaRepository,
  PostPatch,
  PostRepository,
  StylePatch,
  StyleRepository,
  VariantPatch,
  VariantRepository,
  WorkspaceProfileReader,
} from './content/ports/content-store';
export type { ContentDependencies } from './content/application/dependencies';
export {
  CreatePost,
  DeletePost,
  UpdatePost,
  UpdateVariant,
  type CreatePostInput,
  type DeletePostInput,
  type UpdatePostInput,
  type UpdateVariantInput,
} from './content/application/posts';
export {
  CreateStyle,
  UpdateStyle,
  type CreateStyleInput,
  type UpdateStyleInput,
} from './content/application/styles';
export {
  CreateBrandVoice,
  UpdateBrandVoice,
  type CreateBrandVoiceInput,
  type UpdateBrandVoiceInput,
} from './content/application/brand-voices';
export { UpdateIdea, type UpdateIdeaInput } from './content/application/ideas';

// Usage and quotas
export { monthlyPeriodStart, USAGE_METERS, type UsageMeter } from './usage/domain/meters';
export { QuotaExceededError } from './usage/domain/errors';
export type { QuotaKey, QuotaLimits, QuotaStore, UsageSettlement } from './usage/ports/quota-store';
export {
  fixedQuotaLimits,
  QuotaReservation,
  QuotaService,
  type QuotaDependencies,
  type QuotaScope,
  type QuotaUsage,
  type UsageBooking,
} from './usage/application/quota-service';

// Notifications
export type { MailMessage, MailPort } from './notifications/ports/mail.port';

// Tenancy
export * from './tenancy/domain/errors';
export { INVITATION_TTL_MS, normalizeEmail } from './tenancy/domain/invitation';
export {
  assertCanGrantRole,
  assertCanManageMember,
  isManager,
  seesAllWorkspaces,
} from './tenancy/domain/roles';
export { SLUG_PATTERN, slugify } from './tenancy/domain/slug';
export {
  MEMBER_ROLES,
  MISSED_WINDOW_BEHAVIORS,
  type Invitation,
  type MemberRole,
  type Membership,
  type MissedWindowBehavior,
  type Organization,
  type OrganizationActor,
  type Workspace,
  type WorkspaceProfile,
  type WorkspaceSettings,
} from './tenancy/domain/types';
export type { InvitationMessage, InvitationNotifier } from './tenancy/ports/invitation-notifier';
export type { SecretTokens } from './tenancy/ports/secret-tokens';
export type {
  InvitationRepository,
  MembershipRepository,
  OrganizationRepository,
  TenancyScope,
  TenancyStore,
  TenancyUnitOfWork,
  WorkspaceRepository,
} from './tenancy/ports/tenancy-store';
export { AcceptInvitation, type AcceptInvitationInput } from './tenancy/application/accept-invitation';
export { ChangeMemberRole, type ChangeMemberRoleInput } from './tenancy/application/change-member-role';
export {
  CreateOrganization,
  type CreateOrganizationInput,
  type CreateOrganizationResult,
} from './tenancy/application/create-organization';
export { CreateWorkspace, type CreateWorkspaceInput } from './tenancy/application/create-workspace';
export type { TenancyDependencies } from './tenancy/application/dependencies';
export { InviteMember, type InviteMemberInput } from './tenancy/application/invite-member';
export { LeaveOrganization, type LeaveOrganizationInput } from './tenancy/application/leave-organization';
export {
  ResendInvitation,
  RevokeInvitation,
  type InvitationActionInput,
} from './tenancy/application/manage-invitation';
export { RemoveMember, type RemoveMemberInput } from './tenancy/application/remove-member';
export {
  UpdateWorkspaceSettings,
  type UpdateWorkspaceSettingsInput,
} from './tenancy/application/update-workspace-settings';
