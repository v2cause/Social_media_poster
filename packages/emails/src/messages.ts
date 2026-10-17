import type { Locale, platformSchema } from '@smp/contracts';
import type { PublishFailureCode } from '@smp/core';
import type { z } from 'zod';

type Platform = z.output<typeof platformSchema>;

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
    /** Under every notification: where to switch them off. */
    settingsHint: string;
  };
  roles: Record<'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER', string>;
  platforms: Record<Platform, string>;
  /** Why a post did not go out, per failure code of the publish job (guide step 4.8). */
  failureReasons: Record<PublishFailureCode, string>;
  verifyEmail: ActionEmailMessages;
  resetPassword: ActionEmailMessages;
  /** Placeholders: {organization}, {inviter}, {role}. */
  invitation: ActionEmailMessages;
  /** Placeholders: {accounts}, {platform}, {date}. */
  tokenExpiring: { subject: string; preview: string; intro: string; action: string; note: string };
  /** Placeholders: {accounts}, {platform}, {count}. */
  reauthRequired: {
    subject: string;
    preview: string;
    intro: string;
    action: string;
    affectedOne: string;
    affectedMany: string;
  };
  /** Placeholders: {accounts}, {platform}, {reason}, {preview}. */
  publishFailed: {
    subject: string;
    preview: string;
    intro: string;
    reason: string;
    post: string;
    action: string;
  };
  /** Placeholders: {accounts}, {platform}, {preview}. */
  needsAttention: { subject: string; preview: string; intro: string; post: string; action: string };
  /** To the platform admins (guide step 6.5). Placeholders: {count}, {selector}, {flow}, {version}. */
  xBrowserBreaker: { subject: string; preview: string; intro: string; next: string; action: string };
  /** To the platform admins. Placeholders: {missing}, {version}. */
  xBrowserCanary: {
    subject: string;
    preview: string;
    intro: string;
    /** When the canary failed without naming the selectors. */
    introWithout: string;
    next: string;
    action: string;
  };
  /** To the owners of an organization (guide step 7.4). Placeholders: {organization}, {date}. */
  billingPaymentFailed: { subject: string; preview: string; intro: string; grace: string; action: string };
  /** To the owners once it is read-only, per reason. Placeholder: {organization}. */
  billingReadOnly: {
    subject: Record<ReadOnlyReason, string>;
    intro: Record<ReadOnlyReason, string>;
    preview: string;
    effects: string;
    kept: string;
    action: string;
  };
}

/** Why an organization became read-only: its trial ended, a payment stayed out, or its subscription ended. */
export type ReadOnlyReason = 'trial' | 'payment' | 'ended';

export const messages: Record<Locale, EmailMessages> = {
  de: {
    common: {
      greeting: 'Hallo {name},',
      greetingWithoutName: 'Hallo,',
      linkFallback: 'Falls der Button nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
      footer: 'Diese E-Mail wurde von Social Media Poster automatisch versendet.',
      settingsHint:
        'Welche Benachrichtigungen Sie per E-Mail erhalten, legen Sie in Ihren Kontoeinstellungen fest.',
    },
    roles: { OWNER: 'Inhaber', ADMIN: 'Administrator', EDITOR: 'Redakteur', VIEWER: 'Betrachter' },
    platforms: { LINKEDIN: 'LinkedIn', FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', X: 'X' },
    failureReasons: {
      PERMISSION_DENIED: 'Die Plattform hat die nötige Berechtigung verweigert.',
      VALIDATION_REJECTED: 'Die Plattform hat den Inhalt abgelehnt.',
      DUPLICATE: 'Die Plattform hält den Post für ein Duplikat.',
      TRANSIENT: 'Die Plattform war wiederholt nicht erreichbar.',
      MEDIA_PROCESSING: 'Die Bilder waren nicht rechtzeitig fertig.',
      RATE_LIMITED: 'Die Plattform hat zu viele Anfragen gemeldet.',
      OUTCOME_UNKNOWN: 'Es ist unklar, ob der Post erschienen ist.',
      CHALLENGE_REQUIRED: 'Die Plattform verlangt eine Bestätigung der Anmeldung.',
      SELECTOR_DRIFT: 'Die Oberfläche der Plattform hat sich geändert.',
      REAUTH_REQUIRED: 'Der Account muss neu verbunden werden.',
      SPEND_CAP: 'Das Ausgabenlimit für X ist erreicht.',
      MISSED_WINDOW: 'Der geplante Zeitpunkt lag mehr als 6 Stunden zurück.',
      SOCIAL_ACCOUNT_DISCONNECTED: 'Der Account ist nicht mehr verbunden.',
      ADAPTER_UNAVAILABLE: 'Die Plattform ist gerade nicht verfügbar.',
      VARIANT_NOT_PUBLISHABLE: 'Der Inhalt erfüllt die Regeln der Plattform nicht.',
      INTERNAL: 'Ein interner Fehler ist aufgetreten.',
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
    invitation: {
      subject: 'Einladung zu {organization}',
      preview: '{inviter} lädt Sie zu Social Media Poster ein.',
      intro:
        '{inviter} hat Sie eingeladen, der Organisation {organization} auf Social Media Poster beizutreten. Ihre Rolle: {role}.',
      action: 'Einladung annehmen',
      expiry: 'Die Einladung ist sieben Tage gültig und funktioniert nur einmal.',
      ignore: 'Wenn Sie niemanden bei {organization} kennen, können Sie diese E-Mail ignorieren.',
    },
    tokenExpiring: {
      subject: 'Der Zugang zu {accounts} läuft am {date} ab',
      preview: 'Verbinden Sie den Account neu, damit geplante Posts erscheinen.',
      intro:
        'der Zugang zu {accounts} auf {platform} läuft am {date} ab. Danach kann Social Media Poster dort nichts mehr veröffentlichen.',
      action: 'Neu verbinden',
      note: 'Wenn Sie die Verbindung vorher erneuern, bleiben alle geplanten Posts erhalten.',
    },
    reauthRequired: {
      subject: 'Die Verbindung zu {accounts} muss erneuert werden',
      preview: 'Die Verbindung zu {platform} funktioniert nicht mehr.',
      intro:
        'die Verbindung zu {accounts} auf {platform} funktioniert nicht mehr. Bitte stellen Sie sie neu her.',
      action: 'Neu verbinden',
      affectedOne:
        'Ein geplanter Post ist betroffen. Er erscheint nur, wenn Sie die Verbindung vor seinem Termin erneuern.',
      affectedMany:
        '{count} geplante Posts sind betroffen. Sie erscheinen nur, wenn Sie die Verbindung vor ihrem Termin erneuern.',
    },
    publishFailed: {
      subject: 'Ein Post auf {platform} wurde nicht veröffentlicht',
      preview: '{reason}',
      intro: 'Ihr Post für {accounts} auf {platform} konnte nicht veröffentlicht werden.',
      reason: 'Grund: {reason}',
      post: 'Post: „{preview}“',
      action: 'Post öffnen',
    },
    needsAttention: {
      subject: 'Ein Post auf {platform} braucht Ihre Entscheidung',
      preview: 'Es ist unklar, ob der Post erschienen ist.',
      intro:
        'bei Ihrem Post für {accounts} auf {platform} ist unklar, ob er erschienen ist. Bitte sehen Sie auf der Plattform nach und wählen Sie dann „Erneut prüfen“, „Trotzdem posten“ oder „Verwerfen“.',
      post: 'Post: „{preview}“',
      action: 'Post öffnen',
    },
    xBrowserBreaker: {
      subject: 'X ohne API wurde automatisch gestoppt',
      preview: 'Die Oberfläche von X passt nicht mehr zur Selector-Map.',
      intro:
        'der Circuit Breaker hat X ohne API für alle Workspaces abgeschaltet: {count} Abweichungen der Selector-Map innerhalb einer Stunde, zuletzt „{selector}“ im Ablauf „{flow}“ (Selector-Map {version}).',
      next: 'Bitte passen Sie die Selector-Map an die Oberfläche von X an und heben Sie den Kill-Switch danach in der Plattform-Administration auf.',
      action: 'Plattform-Administration öffnen',
    },
    xBrowserCanary: {
      subject: 'Der Canary von X ohne API ist fehlgeschlagen',
      preview: 'Der tägliche Test hat nicht alle Selektoren gefunden.',
      intro: 'der tägliche Canary hat diese Einträge der Selector-Map {version} nicht gefunden: {missing}.',
      introWithout:
        'der tägliche Canary ist fehlgeschlagen, ohne fehlende Einträge der Selector-Map {version} zu nennen.',
      next: 'X ohne API läuft weiter. Drei Abweichungen innerhalb einer Stunde stoppen es automatisch.',
      action: 'Plattform-Administration öffnen',
    },
    billingPaymentFailed: {
      subject: 'Die Zahlung für {organization} ist fehlgeschlagen',
      preview: 'Bitte prüfen Sie Ihre Zahlungsdaten bis {date}.',
      intro:
        'die letzte Zahlung für das Abonnement von {organization} ist fehlgeschlagen. Bitte prüfen Sie Ihre Zahlungsdaten unter Abrechnung.',
      grace:
        'Bis {date} können Sie wie gewohnt weiterarbeiten. Geht die Zahlung bis dahin nicht ein, kann {organization} nur noch lesen: Geplante Posts werden pausiert, und Neues lässt sich nicht mehr anlegen.',
      action: 'Abrechnung öffnen',
    },
    billingReadOnly: {
      subject: {
        trial: 'Die Testphase von {organization} ist beendet',
        payment: '{organization} kann nur noch lesen',
        ended: 'Das Abo von {organization} ist beendet',
      },
      intro: {
        trial: 'die Testphase von {organization} ist beendet.',
        payment: 'die Zahlung für {organization} ist auch nach der Kulanzfrist nicht eingegangen.',
        ended: 'das Abo von {organization} ist beendet.',
      },
      preview: 'Ihre Organisation kann nur noch lesen.',
      effects:
        'Ihre Organisation kann jetzt nur noch lesen: Geplante Posts werden pausiert, und Neues lässt sich nicht anlegen.',
      kept: 'Ihre Inhalte bleiben erhalten. Sobald wieder ein Tarif aktiv ist, arbeiten Sie wie gewohnt weiter.',
      action: 'Tarif wählen',
    },
  },
  en: {
    common: {
      greeting: 'Hello {name},',
      greetingWithoutName: 'Hello,',
      linkFallback: 'If the button does not work, copy this link into your browser:',
      footer: 'This email was sent automatically by Social Media Poster.',
      settingsHint: 'You choose which notifications you get by email in your account settings.',
    },
    roles: { OWNER: 'Owner', ADMIN: 'Admin', EDITOR: 'Editor', VIEWER: 'Viewer' },
    platforms: { LINKEDIN: 'LinkedIn', FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', X: 'X' },
    failureReasons: {
      PERMISSION_DENIED: 'The platform denied a permission it needs.',
      VALIDATION_REJECTED: 'The platform rejected the content.',
      DUPLICATE: 'The platform considers the post a duplicate.',
      TRANSIENT: 'The platform could not be reached several times.',
      MEDIA_PROCESSING: 'The images were not ready in time.',
      RATE_LIMITED: 'The platform reported too many requests.',
      OUTCOME_UNKNOWN: 'It is unclear whether the post went out.',
      CHALLENGE_REQUIRED: 'The platform asks to confirm the login.',
      SELECTOR_DRIFT: 'The interface of the platform has changed.',
      REAUTH_REQUIRED: 'The account needs to be reconnected.',
      SPEND_CAP: 'The spending cap for X has been reached.',
      MISSED_WINDOW: 'The planned time was more than 6 hours ago.',
      SOCIAL_ACCOUNT_DISCONNECTED: 'The account is no longer connected.',
      ADAPTER_UNAVAILABLE: 'The platform is not available right now.',
      VARIANT_NOT_PUBLISHABLE: 'The content does not meet the rules of the platform.',
      INTERNAL: 'An internal error occurred.',
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
    invitation: {
      subject: 'Invitation to {organization}',
      preview: '{inviter} invites you to Social Media Poster.',
      intro:
        '{inviter} invited you to join the organization {organization} on Social Media Poster. Your role: {role}.',
      action: 'Accept invitation',
      expiry: 'The invitation is valid for seven days and works only once.',
      ignore: 'If you do not know anyone at {organization}, you can ignore this email.',
    },
    tokenExpiring: {
      subject: 'Access to {accounts} ends on {date}',
      preview: 'Reconnect the account so that scheduled posts go out.',
      intro:
        'access to {accounts} on {platform} ends on {date}. After that, Social Media Poster cannot publish there.',
      action: 'Reconnect',
      note: 'If you renew the connection before then, all scheduled posts are kept.',
    },
    reauthRequired: {
      subject: 'Reconnect {accounts}',
      preview: 'The connection to {platform} no longer works.',
      intro: 'the connection to {accounts} on {platform} no longer works. Please renew it.',
      action: 'Reconnect',
      affectedOne:
        'One scheduled post is affected. It only goes out if you renew the connection before its time.',
      affectedMany:
        '{count} scheduled posts are affected. They only go out if you renew the connection before their time.',
    },
    publishFailed: {
      subject: 'A post on {platform} was not published',
      preview: '{reason}',
      intro: 'your post for {accounts} on {platform} could not be published.',
      reason: 'Reason: {reason}',
      post: 'Post: “{preview}”',
      action: 'Open post',
    },
    needsAttention: {
      subject: 'A post on {platform} needs your decision',
      preview: 'It is unclear whether the post went out.',
      intro:
        'for your post for {accounts} on {platform} it is unclear whether it went out. Please check the platform, then choose “Check again”, “Post anyway” or “Discard”.',
      post: 'Post: “{preview}”',
      action: 'Open post',
    },
    xBrowserBreaker: {
      subject: 'X without the API was stopped automatically',
      preview: 'The interface of X no longer matches the selector map.',
      intro:
        'the circuit breaker switched X without the API off for every workspace: {count} drifts of the selector map within an hour, the last one “{selector}” in the flow “{flow}” (selector map {version}).',
      next: 'Please adapt the selector map to the interface of X, then lift the kill switch on the platform admin page.',
      action: 'Open the platform admin page',
    },
    xBrowserCanary: {
      subject: 'The canary of X without the API failed',
      preview: 'The daily check did not find every selector.',
      intro: 'the daily canary did not find these entries of the selector map {version}: {missing}.',
      introWithout: 'the daily canary failed without naming missing entries of the selector map {version}.',
      next: 'X without the API keeps running. Three drifts within an hour stop it automatically.',
      action: 'Open the platform admin page',
    },
    billingPaymentFailed: {
      subject: 'The payment for {organization} failed',
      preview: 'Please check your payment details by {date}.',
      intro:
        'the last payment for the subscription of {organization} failed. Please check your payment details under Billing.',
      grace:
        'Until {date} you can keep working as usual. If the payment has not arrived by then, {organization} becomes read-only: scheduled posts are paused, and nothing new can be created.',
      action: 'Open billing',
    },
    billingReadOnly: {
      subject: {
        trial: 'The trial of {organization} has ended',
        payment: '{organization} is read-only now',
        ended: 'The subscription of {organization} has ended',
      },
      intro: {
        trial: 'the trial of {organization} has ended.',
        payment: 'the payment for {organization} did not arrive within the grace period.',
        ended: 'the subscription of {organization} has ended.',
      },
      preview: 'Your organization is read-only now.',
      effects:
        'Your organization is read-only now: scheduled posts are paused, and nothing new can be created.',
      kept: 'Your content is kept. As soon as a plan is active again, you can work as usual.',
      action: 'Choose a plan',
    },
  },
};

/** Replaces {key} placeholders. Values are text; React escapes them when rendering. */
export const format = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
