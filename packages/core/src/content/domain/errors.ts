import { DomainError } from '../../shared/domain/errors';

export class PostNotFoundError extends DomainError {
  readonly code = 'POST_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The post does not exist in this workspace.');
  }
}

export class VariantNotFoundError extends DomainError {
  readonly code = 'VARIANT_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The variant does not exist in this workspace.');
  }
}

export class StyleNotFoundError extends DomainError {
  readonly code = 'STYLE_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The style does not exist in this workspace.');
  }
}

export class BrandVoiceNotFoundError extends DomainError {
  readonly code = 'BRAND_VOICE_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The brand voice does not exist in this workspace.');
  }
}

export class IdeaNotFoundError extends DomainError {
  readonly code = 'IDEA_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The idea does not exist in this workspace.');
  }
}

/** Someone else changed the entity since the client read it (optimistic locking). */
export class VersionConflictError extends DomainError {
  readonly code = 'VERSION_CONFLICT';
  readonly kind = 'conflict';
  constructor() {
    super('The entity was changed in the meantime. Reload it or overwrite the change.');
  }
}

/** The variant is being published or was published; its content is fixed. */
export class VariantLockedError extends DomainError {
  readonly code = 'VARIANT_LOCKED';
  readonly kind = 'conflict';
  constructor() {
    super('The variant cannot change in its current status.');
  }
}

export class PostLockedError extends DomainError {
  readonly code = 'POST_LOCKED';
  readonly kind = 'conflict';
  constructor() {
    super('A variant of the post is being published; the post cannot change or be deleted now.');
  }
}

/** The presets are the same for every workspace and cannot change. */
export class PresetStyleError extends DomainError {
  readonly code = 'STYLE_IS_PRESET';
  readonly kind = 'forbidden';
  constructor() {
    super('Preset styles cannot be changed.');
  }
}

export class StyleNameTakenError extends DomainError {
  readonly code = 'STYLE_NAME_TAKEN';
  readonly kind = 'conflict';
  constructor() {
    super('A style with this name already exists in the workspace.');
  }
}

export class BrandVoiceArchivedError extends DomainError {
  readonly code = 'BRAND_VOICE_ARCHIVED';
  readonly kind = 'invalid';
  constructor() {
    super('An archived brand voice cannot be used for new content.');
  }
}

export class BriefRequiredError extends DomainError {
  readonly code = 'BRIEF_REQUIRED';
  readonly kind = 'invalid';
  constructor() {
    super('The post needs a brief before the AI can write it.');
  }
}
