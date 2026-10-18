// Domain core: entities, use cases and ports. Framework-free by rule.

// Shared kernel
export {
  DomainError,
  isDomainError,
  NotPermittedError,
  type DomainErrorKind,
  type DomainErrorParams,
} from './shared/domain/errors';
export { systemClock, uuidV7Ids } from './shared/adapters/system';
export type { Clock } from './shared/ports/clock';
export type { IdGenerator } from './shared/ports/ids';
export {
  OUTBOX_EVENT_TYPES,
  type OutboxEventInput,
  type OutboxEventPayloads,
  type OutboxEventType,
} from './shared/domain/outbox';

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
export { AiCallFailedError, AiRateLimitedError } from './ai/domain/errors';
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
  ALT_TEXT_SUGGESTION_MAX,
  SuggestAltText,
  type SuggestAltTextCommand,
} from './ai/application/suggest-alt-text';
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
  TopPostContext,
  VariantStreamEvent,
} from './ai/ports/ai-provider';

// Audit
export { assertSafeAuditMetadata, UnsafeAuditMetadataError } from './audit/domain/audit-metadata';
export type { AuditEntry, AuditTrail } from './audit/ports/audit-trail';

// Content (architecture 6.2)
export * from './content/domain/errors';
export {
  postSourceOf,
  resolveIdeaSources,
  topPostRefOf,
  variantIdOfSource,
} from './content/domain/idea-sources';
export {
  canManageBrand,
  canonicalJson,
  canWriteContent,
  customStyleKey,
  isVariantEditable,
  isVariantInFlight,
  nextTargetKeys,
  statusAfterEdit,
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
  TopPerformer,
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

// Notifications (guide steps 1.8 and 4.9)
export type { MailMessage, MailPort } from './notifications/ports/mail.port';
export {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationChannels,
  type NotificationContent,
  type NotificationRecipient,
  type NotificationRequest,
  type NotificationType,
  type NotificationWorkspace,
} from './notifications/domain/types';
export {
  audienceOf,
  DEFAULT_CHANNELS,
  PREVIEW_LENGTH,
  PREVIEW_MAX_UNITS,
  previewOf,
} from './notifications/domain/rules';
export type {
  InAppNotification,
  NotificationDirectory,
  NotificationEmail,
  NotificationInbox,
  NotificationMailer,
  NotificationPreference,
  NotificationScope,
  NotificationSignals,
  UserNotifications,
} from './notifications/ports/notification-store';
export {
  DeliverNotification,
  type DeliverNotificationInput,
  type DeliveryReport,
} from './notifications/application/deliver-notification';
export {
  MarkNotificationsRead,
  SetNotificationPreferences,
} from './notifications/application/user-notifications';

// Channels (architecture 4, guide steps 4.2 ff.)
export {
  accountSecretAad,
  CONNECTION_SECRET_FIELDS,
  connectionSecretAad,
  pendingSecretAad,
  SEALED_SECRET_COLUMNS,
  type ConnectionSecretField,
  type SealedSecretColumn,
  type SealedSecretOwner,
  type SecretKeyring,
} from './channels/domain/secrets';
export type {
  SealedSecretRow,
  SealedSecretStore,
  SecretRewrapper,
  SecretSealer,
} from './channels/ports/secrets';
export { RewrapSecrets, type RewrapReport } from './channels/application/rewrap-secrets';
export {
  CONNECTION_METHODS,
  CONNECTION_STATUSES,
  SOCIAL_ACCOUNT_TYPES,
  type ConnectionMethod,
  type ConnectionStatus,
  type SocialAccount,
  type SocialAccountType,
  type SocialConnection,
} from './channels/domain/types';
export {
  accessExpiryOf,
  canManageChannels,
  missingScopesOf,
  OAUTH_STATE_TTL_MS,
  PENDING_CONNECTION_TTL_MS,
} from './channels/domain/rules';
export * from './channels/domain/errors';
export {
  isPlatformError,
  PLATFORM_ERROR_CODES,
  PlatformError,
  type PlatformErrorCode,
  type PlatformErrorDetails,
} from './channels/domain/platform-error';
export type {
  AccountMetricsResult,
  AdapterAccount,
  AdapterContext,
  AdapterLogger,
  ApiCostRecorder,
  AuthorizationRequest,
  BrowserContext,
  ConnectableAccount,
  CredentialsAccessor,
  DateRange,
  ExternalPostRef,
  NormalizedPostMetrics,
  OAuthConnector,
  OAuthGrant,
  PostMetricsResult,
  PublishMedia,
  PublishRequest,
  PublishResult,
  RefreshOutcome,
  SocialPlatformAdapter,
  TokenSet,
} from './channels/ports/platform-adapter';
export type {
  ChannelScope,
  ChannelStore,
  ChannelUnitOfWork,
  ConnectionGrant,
  NewSocialConnection,
  SocialAccountRepository,
  SocialAccountWrite,
  SocialConnectionRepository,
} from './channels/ports/channel-store';
export type {
  ChannelConnectors,
  ConnectableAccountView,
  OAuthRandom,
  OAuthState,
  OAuthStateStore,
  PendingConnection,
  PendingConnectionStore,
} from './channels/ports/oauth';
export type { ChannelDependencies } from './channels/application/dependencies';
export { StartConnection, type StartConnectionInput } from './channels/application/start-connection';
export {
  AUTHORIZATION_FAILURES,
  CompleteAuthorization,
  type AuthorizationFailure,
  type AuthorizationOutcome,
  type CompleteAuthorizationInput,
} from './channels/application/complete-authorization';
export {
  GetPendingConnection,
  type PendingConnectionView,
} from './channels/application/get-pending-connection';
export {
  ConfirmConnection,
  type ConfirmConnectionInput,
  type ConfirmedConnection,
} from './channels/application/confirm-connection';
export {
  DisconnectAccount,
  revokeAtPlatform,
  type DisconnectResult,
} from './channels/application/disconnect-account';
export {
  EXPIRY_NOTICE_DAYS,
  isInExpiryWindow,
  isNoticeDue,
  noticeStageOf,
  statusAfterRefresh,
  TOKEN_EXPIRY_WINDOW_MS,
  TOKEN_REFRESH_MARGIN_MS,
} from './channels/domain/token-monitor';
export type {
  AdapterResolver,
  ConnectedAccount,
  ConnectionLock,
  ExpiringConnection,
  ExpiringConnectionScanner,
  MaintainedConnectionRepository,
  ReauthMark,
  RefreshedTokens,
  TokenConnectionRepository,
  TokenMaintenanceScope,
  TokenMaintenanceStore,
  TokenMaintenanceUnitOfWork,
  TokenRefreshRequests,
} from './channels/ports/token-maintenance';
export {
  ConnectionTokens,
  ReauthRequiredError,
  type TokenRefreshResult,
  type TokenTarget,
} from './channels/application/connection-tokens';
export { MonitorTokens, type TokenMonitorReport } from './channels/application/monitor-tokens';
export {
  RefreshConnection,
  type RefreshConnectionDependencies,
  type RefreshConnectionInput,
  type RefreshConnectionOutcome,
} from './channels/application/refresh-connection';
export {
  OUTSIDE_BLOCKS,
  X_BROWSER_BLOCKS,
  X_BROWSER_FLAG,
  X_BROWSER_RISK_SUBJECT,
  xBrowserBlocks,
  type XBrowserBlock,
  type XBrowserConditions,
  type XBrowserFlags,
} from './channels/domain/x-browser';
export type {
  NewRiskAcknowledgement,
  RiskAcknowledgement,
  SelectorDrift,
  SelectorDriftCounter,
  XBrowserAdminStore,
  XBrowserAlerts,
  XBrowserKillSignal,
  XBrowserOrganization,
  XBrowserScope,
  XBrowserStore,
  XBrowserUnitOfWork,
} from './channels/ports/x-browser';
export {
  DisableXBrowser,
  EnableXBrowser,
  GetXBrowserStatus,
  XBrowserGate,
  type EnableXBrowserInput,
  type RiskText,
  type XBrowserAccessDependencies,
  type XBrowserStatus,
} from './channels/application/x-browser-access';
export {
  StoreBrowserSession,
  type StoreBrowserSessionInput,
} from './channels/application/store-browser-session';
export {
  BREAKER_DRIFTS,
  BREAKER_WINDOW_MS,
  XBrowserBreaker,
  type BreakerOutcome,
  type CanaryReport,
  type XBrowserBreakerDependencies,
} from './channels/application/x-browser-breaker';
export {
  GetXBrowserAdmin,
  SetXBrowserKillSwitch,
  SetXBrowserOrganization,
  type XBrowserAdminDependencies,
  type XBrowserAdminView,
} from './channels/application/x-browser-admin';
export {
  BROWSER_LOGIN_FAILURES,
  BROWSER_LOGIN_STATUSES,
  OPEN_BROWSER_LOGIN_STATUSES,
  type BrowserLogin,
  type BrowserLoginAad,
  type BrowserLoginCommand,
  type BrowserLoginEvents,
  type BrowserLoginFailure,
  type BrowserLoginQueue,
  type BrowserLoginStatus,
  type BrowserLoginStore,
} from './channels/ports/browser-login';
export {
  BROWSER_LOGIN_START_WINDOW_MS,
  BROWSER_LOGIN_TTL_MS,
  BROWSER_LOGINS_PER_HOUR,
  CompleteBrowserLogin,
  GetBrowserLogin,
  RecordBrowserLoginStep,
  StartBrowserLogin,
  SubmitBrowserLoginCode,
  type BrowserLoginCompletion,
  type BrowserLoginDependencies,
  type BrowserLoginStep,
  type CompleteBrowserLoginInput,
  type RecordBrowserLoginStepInput,
  type StartBrowserLoginInput,
  type SubmitBrowserLoginCodeInput,
} from './channels/application/browser-login';

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
export {
  MEDIA_REJECT_REASONS,
  MEDIA_STATUSES,
  type Crop,
  type MediaAsset,
  type MediaRejectReason,
  type MediaRendition,
  type MediaStatus,
  type PostMedia,
  type ProcessedAsset,
} from './media/domain/types';
export {
  canWriteMedia,
  cropHashOf,
  displayFileName,
  FULL_IMAGE,
  isUploadMimeType,
  MAX_INPUT_PIXELS,
  MAX_UPLOAD_BYTES,
  MAX_VARIANT_MEDIA,
  READ_URL_SECONDS,
  THUMBNAIL_PROFILES,
  UPLOAD_MIME_TYPES,
  UPLOAD_URL_SECONDS,
  type UploadMimeType,
} from './media/domain/rules';
export {
  CropOutOfBoundsError,
  ImageRejectedError,
  MediaInUseError,
  MediaNotFoundError,
  MediaNotReadyError,
  MediaTooLargeError,
  MediaTypeNotAllowedError,
  RenditionNotPossibleError,
  RenditionTooLargeError,
  StorageQuotaExceededError,
  UploadMissingError,
  VariantMediaInvalidError,
} from './media/domain/errors';
export { sniffImageType, type SniffedImageType } from './media/domain/file-signature';
export { assetPrefix, originalKey, renditionKey, workspacePrefix } from './media/domain/storage-keys';
export type { PresignedUpload, StoragePort, StoredObject } from './media/ports/storage';
export type {
  EncodedImage,
  EncodeOptions,
  ImageInfo,
  ImageProcessor,
  RenderOptions,
} from './media/ports/image-processor';
export type { MediaJob, MediaJobs, RenderJob } from './media/ports/media-jobs';
export type {
  MediaAssetRepository,
  MediaRenditionRepository,
  MediaScope,
  MediaStore,
  MediaUnitOfWork,
  PostMediaRepository,
  VariantRef,
  VariantRefRepository,
} from './media/ports/media-store';
export {
  assertCanWriteMedia,
  mediaScopeOf,
  type MediaDependencies,
  type MediaLimits,
} from './media/application/dependencies';
export {
  RequestUpload,
  type RequestUploadInput,
  type UploadTicket,
} from './media/application/request-upload';
export { CompleteUpload, type CompleteUploadInput } from './media/application/complete-upload';
export { ProcessAsset, type ProcessOutcome } from './media/application/process-asset';
export { UpdateMediaAltText, type UpdateMediaAltTextInput } from './media/application/update-media';
export { DeleteMedia, type DeleteMediaInput } from './media/application/delete-media';
export { RenderRendition, type RenderRenditionInput } from './media/application/render-rendition';
export { RenderAttachedMedia, type RenderJobOutcome } from './media/application/render-attached-media';
export {
  SetVariantMedia,
  type SetVariantMediaInput,
  type VariantMediaItem,
} from './media/application/set-variant-media';
export type { ExpiredAsset, ExpiredMediaCutoffs, MediaCleanupStore } from './media/ports/media-cleanup-store';
export {
  CleanUpMedia,
  DELETED_MEDIA_DAYS,
  PENDING_UPLOAD_HOURS,
  type MediaCleanupDependencies,
  type MediaCleanupReport,
} from './media/application/clean-up-media';

// Publishing (architecture 7, guide steps 4.6 ff.)
export { canTransition, VARIANT_TRANSITIONS } from './publishing/domain/variant-state-machine';
export {
  formatLocalTime,
  isKnownTimeZone,
  resolveLocalTime,
  type LocalTimeResolution,
} from './publishing/domain/local-time';
export * from './publishing/domain/errors';
export {
  canPublish,
  isConnectionUsable,
  MISSED_WINDOW_MS,
  SCHEDULE_WARNINGS,
  type ScheduleWarning,
} from './publishing/domain/rules';
export type {
  OutboxWriter,
  PublishingScope,
  PublishingStore,
  PublishingTarget,
  PublishingTargetRepository,
  PublishingUnitOfWork,
  PublishingVariantRepository,
  SchedulableVariant,
  ScheduleChange,
  VariantMediaReader,
  VariantMediaSource,
} from './publishing/ports/publishing-store';
export type { LocalTime, PlanResult, PublishingDependencies } from './publishing/application/planning';
export {
  RescheduleVariant,
  ScheduleVariant,
  type ScheduleVariantInput,
} from './publishing/application/schedule-variant';
export { CancelVariant } from './publishing/application/cancel-variant';
export { PublishNow, type PublishNowInput } from './publishing/application/publish-now';
export { RetryVariant, type RetryVariantInput } from './publishing/application/retry-variant';
export {
  NEEDS_ATTENTION_ACTIONS,
  ResolveNeedsAttention,
  type NeedsAttentionAction,
  type ResolveNeedsAttentionInput,
} from './publishing/application/resolve-needs-attention';
export {
  isMissedWindow,
  isRunnable,
  LEASE_GRACE_MS,
  PUBLISH_FAILURE_CODES,
  PUBLISH_LEASE_MS,
  RATE_LIMIT_FALLBACK_MS,
  reactionTo,
  RECONCILE_SKEW_MS,
  type PlatformErrorReaction,
  type PublishFailureCode,
} from './publishing/domain/publish-job';
export {
  PUBLISH_ATTEMPT_OUTCOMES,
  PUBLISH_JOB_TRIGGERS,
  type ApiCostEntry,
  type ApiCostRepository,
  type Lease,
  type NewPublishAttempt,
  type OperationPrices,
  type PublishAttemptOutcome,
  type PublishAttemptRepository,
  type PublishAttemptResult,
  type PublishJobConnectionRepository,
  type PublishJobMediaRepository,
  type PublishJobScope,
  type PublishJobStore,
  type PublishJobTarget,
  type PublishJobTargetRepository,
  type PublishJobTrigger,
  type PublishJobUnitOfWork,
  type PublishJobVariant,
  type PublishJobVariantRepository,
  type PublishMediaItem,
  type PublishRendition,
  type UnclearAttempt,
  type VariantRunResult,
} from './publishing/ports/publish-job';
export type {
  PublishJobDependencies,
  PublishJobInput,
  PublishJobOutcome,
} from './publishing/application/publish-job-types';
export { PublishVariant } from './publishing/application/publish-variant';

// Analytics (phase 5).
export { cadenceHours, METRICS_BATCH_SIZE, metricsDueAt, nextPollAfter } from './analytics/domain/cadence';
export { daysBefore, localDayOf, localDayRange, nextDay, startOfLocalDay } from './analytics/domain/days';
export { engagementsOf, type Interactions } from './analytics/domain/metrics';
export {
  bucketOf,
  dailyEngagementRateOf,
  daysBetween,
  engagementRateOf,
  followerGrowthOf,
  followersByDay,
  impressionsOf,
  metricOf,
  reachOf,
  seriesOf,
  sumOf,
  type DailyMetrics,
  type Granularity,
  type ReachBasis,
  type TimeseriesMetric,
} from './analytics/domain/kpis';
export {
  analyticsPeriodOf,
  DEFAULT_PERIOD_DAYS,
  periodLength,
  type AnalyticsPeriod,
} from './analytics/domain/period';
export { AnalyticsHistoryExceededError } from './analytics/domain/errors';
export {
  breakdownOf,
  isoWeekdayOf,
  type BreakdownBy,
  type BreakdownGroup,
  type BreakdownPost,
} from './analytics/domain/breakdown';
export {
  fixedAnalyticsHistory,
  resolveAnalyticsPeriod,
  type AnalyticsHistory,
} from './analytics/application/analytics-period';
export {
  POLL_RETRY_MS,
  type AnalyticsJobDependencies,
  type AnalyticsJobInput,
} from './analytics/application/analytics-job';
export {
  CollectPostMetrics,
  METRICS_LEASE_MS,
  type CollectPostMetricsResult,
} from './analytics/application/collect-post-metrics';
export {
  CollectAccountMetrics,
  type CollectAccountMetricsInput,
  type CollectAccountMetricsResult,
} from './analytics/application/collect-account-metrics';
export {
  NIGHTLY_ROLLUP_DAYS,
  RollUpAnalytics,
  type RollUpAnalyticsInput,
} from './analytics/application/roll-up-analytics';
export type {
  AccountDailyMetrics,
  AccountMetricsRepository,
  AnalyticsRollupRepository,
  AnalyticsScope,
  AnalyticsStore,
  AnalyticsUnitOfWork,
  DueAccountDay,
  DueMetricsAccount,
  DueVariant,
  MetricsPlanScanner,
  PostMetricsRepository,
  RollupRequest,
  RollupRequests,
  VariantPoll,
} from './analytics/ports/analytics';

// Billing (phase 7).
export * from './billing/domain/errors';
export { assertWithinLimit } from './billing/domain/limits';
export {
  aiCapMicros,
  effectiveLimits,
  PLAN_KEYS,
  type CountedLimit,
  type Plan,
  type PlanKey,
  type PlanLimits,
} from './billing/domain/plan';
export {
  GRACE_DAYS,
  graceEndOf,
  isReadOnlyAt,
  readOnlyAtOf,
  readOnlyReasonOf,
  SUBSCRIPTION_STATUSES,
  TRIAL_DAYS,
  trialFrom,
  type AccessState,
  type ReadOnlyReason,
  type SubscriptionStatus,
} from './billing/domain/subscription';
export {
  syncSubscription,
  type BillingState,
  type ReportedSubscription,
  type SyncOutcome,
} from './billing/domain/sync';
export type { Subscription, SubscriptionReader, TrialStarter } from './billing/ports/subscription-store';
export {
  BILLING_WEBHOOK_TYPES,
  INVOICE_STATUSES,
  USAGE_METER_NAMES,
  type BillingGateway,
  type BillingWebhookEvent,
  type BillingWebhookType,
  type BillingWebhookVerifier,
  type CheckoutRequest,
  type InvoiceStatus,
  type InvoiceSummary,
  type PlanPrice,
  type PortalRequest,
  type ProviderSubscription,
  type UsageMeterName,
} from './billing/ports/billing-gateway';
export type {
  BillingCustomers,
  BillingJobs,
  BillingLock,
  BillingNotifier,
  ReadOnlyNotices,
  StoredWebhook,
  SubscriptionSync,
  WebhookInbox,
} from './billing/ports/billing-store';
export { AnnounceReadOnly } from './billing/application/read-only-notices';
export {
  EntitlementsService,
  type Entitlements,
  type EntitlementsDependencies,
} from './billing/application/entitlements';
export {
  ChangePlan,
  ListInvoices,
  OpenBillingPortal,
  runsPaid,
  StartCheckout,
  type BillingActor,
  type BillingDependencies,
} from './billing/application/checkout';
export {
  ProcessStripeWebhook,
  RecordStripeWebhook,
  type ProcessStripeWebhookDependencies,
  type ProcessStripeWebhookResult,
} from './billing/application/webhooks';
export {
  METER_EVENT_MAX_AGE_DAYS,
  meterTimestampOf,
  overageOf,
  reportCutoffOf,
} from './billing/domain/usage';
export type { UsageBatch, UsageReportStore } from './billing/ports/usage-report-store';
export type { PlanUsage } from './billing/ports/plan-usage';
export {
  GetBillingOverview,
  PlanPrices,
  type BillingOverview,
  type BillingOverviewDependencies,
  type OrganizationUsage,
} from './billing/application/overview';
export {
  planAccountLimits,
  planAnalyticsHistory,
  planMediaLimits,
  planPostLimits,
  planQuotaLimits,
  planXSpendCap,
  unlimitedAccounts,
  unlimitedPosts,
  type AccountLimits,
  type PlanEntitlements,
  type PostLimits,
  type XSpendCap,
} from './billing/application/plan-limits';
export {
  ReportUsage,
  type UsageReportDependencies,
  type UsageReportResult,
} from './billing/application/usage-report';

// Data protection (phase 8)
export * from './gdpr/domain/errors';
export {
  DOWNLOAD_LINK_SECONDS,
  ERASURE_DELAY_DAYS,
  EXPORT_AVAILABLE_HOURS,
  GDPR_REQUEST_KINDS,
  GDPR_REQUEST_STATUSES,
  erasureDateOf,
  exportExpiryOf,
  exportFileNameOf,
  exportKeyOf,
  exportPrefixOf,
  isDownloadable,
  isOpen,
  type GdprRequest,
  type GdprRequestDetails,
  type GdprRequestKind,
  type GdprRequestStatus,
} from './gdpr/domain/request';
export type {
  DeletableOrganization,
  DeletionBilling,
  GdprJobs,
  GdprRequestRepository,
  GdprRequestRunner,
  GdprScope,
  GdprStore,
  GdprUnitOfWork,
  OrganizationDeletion,
} from './gdpr/ports/gdpr-store';
export type {
  ExportArchive,
  ExportArchives,
  ExportedMedia,
  ExportedOrganization,
  GdprNotifier,
  GrantRevoker,
  OrganizationDataSource,
  OrganizationEraser,
} from './gdpr/ports/gdpr-runtime';
export {
  DownloadDataExport,
  ListDataExports,
  RequestDataExport,
  type GdprDependencies,
} from './gdpr/application/requests';
export {
  ExpireExports,
  ExportOrganizationData,
  archiveName,
  type ExportDependencies,
  type ExportResult,
} from './gdpr/application/export';
export {
  CancelOrganizationErasure,
  RequestOrganizationErasure,
  type DeletionDependencies,
} from './gdpr/application/deletion';
export {
  EraseOrganization,
  ErasureIncompleteError,
  ScheduleErasures,
  type ErasureDependencies,
  type ErasureResult,
} from './gdpr/application/erasure';
export { SubscriptionDeletionBilling } from './billing/application/deletion-billing';
export type { RetentionStore } from './gdpr/ports/retention-store';
export {
  AI_RAW_DATA_DAYS,
  ApplyRetention,
  CONNECTION_DATA_DAYS,
  MIN_METRICS_DAYS,
  PROCESSED_WEBHOOK_DAYS,
  type RetentionDependencies,
  type RetentionReport,
  UNVERIFIED_ACCOUNT_HOURS,
} from './gdpr/application/retention';
