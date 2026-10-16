import type { Platform } from '../platforms';
import { facebook } from './facebook';
import { instagram } from './instagram';
import { linkedin } from './linkedin';
import type { PlatformCapabilities } from './types';
import { x } from './x';

export const CAPABILITIES: Readonly<Record<Platform, PlatformCapabilities>> = {
  LINKEDIN: linkedin,
  INSTAGRAM: instagram,
  FACEBOOK: facebook,
  X: x,
};

export const capabilitiesOf = (platform: Platform): PlatformCapabilities => CAPABILITIES[platform];
