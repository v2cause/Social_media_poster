import deAccount from '../../messages/de/account.json';
import deAuth from '../../messages/de/auth.json';
import deBrand from '../../messages/de/brand.json';
import deCommon from '../../messages/de/common.json';
import deComposer from '../../messages/de/composer.json';
import deErrors from '../../messages/de/errors.json';
import deIdeas from '../../messages/de/ideas.json';
import deOnboarding from '../../messages/de/onboarding.json';
import dePosts from '../../messages/de/posts.json';
import deTeam from '../../messages/de/team.json';
import enAccount from '../../messages/en/account.json';
import enAuth from '../../messages/en/auth.json';
import enBrand from '../../messages/en/brand.json';
import enCommon from '../../messages/en/common.json';
import enComposer from '../../messages/en/composer.json';
import enErrors from '../../messages/en/errors.json';
import enIdeas from '../../messages/en/ideas.json';
import enOnboarding from '../../messages/en/onboarding.json';
import enPosts from '../../messages/en/posts.json';
import enTeam from '../../messages/en/team.json';
import type { Locale } from './locale';

// One file per namespace and language (guide step 1.10). The keys of common.json are top-level
// namespaces themselves (app, nav, shell, ...); every other file is the namespace of its name.
const MESSAGES = {
  de: {
    ...deCommon,
    auth: deAuth,
    onboarding: deOnboarding,
    team: deTeam,
    account: deAccount,
    composer: deComposer,
    posts: dePosts,
    ideas: deIdeas,
    brand: deBrand,
    errors: deErrors,
  },
  en: {
    ...enCommon,
    auth: enAuth,
    onboarding: enOnboarding,
    team: enTeam,
    account: enAccount,
    composer: enComposer,
    posts: enPosts,
    ideas: enIdeas,
    brand: enBrand,
    errors: enErrors,
  },
} as const;

export type Messages = (typeof MESSAGES)['de'];

export const messagesFor = (locale: Locale): Messages => MESSAGES[locale];
