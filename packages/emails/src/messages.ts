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
  verifyEmail: ActionEmailMessages;
  resetPassword: ActionEmailMessages;
}

export const messages: Record<Locale, EmailMessages> = {
  de: {
    common: {
      greeting: 'Hallo {name},',
      greetingWithoutName: 'Hallo,',
      linkFallback: 'Falls der Button nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
      footer: 'Diese E-Mail wurde von Social Media Poster automatisch versendet.',
    },
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
  },
  en: {
    common: {
      greeting: 'Hello {name},',
      greetingWithoutName: 'Hello,',
      linkFallback: 'If the button does not work, copy this link into your browser:',
      footer: 'This email was sent automatically by Social Media Poster.',
    },
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
  },
};

/** Replaces {key} placeholders. Values are text; React escapes them when rendering. */
export const format = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
