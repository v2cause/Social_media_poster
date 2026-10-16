import type { Locale } from '@smp/contracts';

// Email texts per locale. The interface makes both languages carry every key.

interface ActionEmailMessages {
  subject: string;
  preview: string;
  intro: string;
  action: string;
  expiry: string;
  ignore: string;
}

export interface EmailMessages {
  common: {
    greeting: string;
    greetingWithoutName: string;
    linkFallback: string;
    footer: string;
  };
  roles: Record<'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER', string>;
  verifyEmail: ActionEmailMessages;
  resetPassword: ActionEmailMessages;
  /** Placeholders: {organization}, {inviter}, {role}. */
  invitation: ActionEmailMessages;
}

export const messages: Record<Locale, EmailMessages> = {
  de: {
    common: {
      greeting: 'Hallo {name},',
      greetingWithoutName: 'Hallo,',
      linkFallback: 'Falls der Button nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
      footer: 'Diese E-Mail wurde von Social Media Poster automatisch versendet.',
    },
    roles: { OWNER: 'Inhaber', ADMIN: 'Administrator', EDITOR: 'Redakteur', VIEWER: 'Betrachter' },
    verifyEmail: {
      subject: 'Bestätigen Sie Ihre E-Mail-Adresse',
      preview: 'Ein Klick, dann ist Ihr Konto aktiv.',
      intro: 'bitte bestätigen Sie Ihre E-Mail-Adresse, damit wir Ihr Konto aktivieren können.',
      action: 'E-Mail-Adresse bestätigen',
      expiry: 'Der Link ist eine Stunde gültig.',
      ignore: 'Wenn Sie sich nicht registriert haben, können Sie diese E-Mail ignorieren.',
    },
    resetPassword: {
      subject: 'Passwort zurücksetzen',
      preview: 'Legen Sie ein neues Passwort fest.',
      intro: 'Sie haben angefordert, das Passwort Ihres Kontos zurückzusetzen.',
      action: 'Neues Passwort festlegen',
      expiry: 'Der Link ist eine Stunde gültig und funktioniert nur einmal.',
      ignore:
        'Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail. Ihr Passwort bleibt unverändert.',
    },
    invitation: {
      subject: 'Einladung zu {organization}',
      preview: '{inviter} lädt Sie zu Social Media Poster ein.',
      intro:
        '{inviter} hat Sie eingeladen, der Organisation {organization} auf Social Media Poster beizutreten. Ihre Rolle: {role}.',
      action: 'Einladung annehmen',
      expiry: 'Die Einladung ist sieben Tage gültig und funktioniert nur einmal.',
      ignore: 'Wenn Sie niemanden bei {organization} kennen, können Sie diese E-Mail ignorieren.',
    },
  },
  en: {
    common: {
      greeting: 'Hello {name},',
      greetingWithoutName: 'Hello,',
      linkFallback: 'If the button does not work, copy this link into your browser:',
      footer: 'This email was sent automatically by Social Media Poster.',
    },
    roles: { OWNER: 'Owner', ADMIN: 'Admin', EDITOR: 'Editor', VIEWER: 'Viewer' },
    verifyEmail: {
      subject: 'Confirm your email address',
      preview: 'One click and your account is active.',
      intro: 'please confirm your email address so that we can activate your account.',
      action: 'Confirm email address',
      expiry: 'The link is valid for one hour.',
      ignore: 'If you did not sign up, you can ignore this email.',
    },
    resetPassword: {
      subject: 'Reset your password',
      preview: 'Choose a new password.',
      intro: 'You asked to reset the password of your account.',
      action: 'Choose a new password',
      expiry: 'The link is valid for one hour and works only once.',
      ignore: 'If you did not ask for this, ignore this email. Your password stays the same.',
    },
    invitation: {
      subject: 'Invitation to {organization}',
      preview: '{inviter} invites you to Social Media Poster.',
      intro:
        '{inviter} invited you to join the organization {organization} on Social Media Poster. Your role: {role}.',
      action: 'Accept invitation',
      expiry: 'The invitation is valid for seven days and works only once.',
      ignore: 'If you do not know anyone at {organization}, you can ignore this email.',
    },
  },
};

/** Replaces {key} placeholders. Values are text; React escapes them when rendering. */
export const format = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
