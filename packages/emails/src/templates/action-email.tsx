import type { Locale } from '@smp/contracts';
import type { ReactNode } from 'react';

import { ActionButton, EmailLayout, LinkFallback, Paragraph } from '../components/layout';

export interface ActionEmailText {
  subject: string;
  preview: string;
  greeting: string;
  /** What happened or what to do, one paragraph each, before the button. */
  intro: string[];
  action: string;
  linkFallback: string;
  /** One paragraph each after the button, for example how long the link works. */
  notes: string[];
  footer: string;
}

/**
 * An email whose purpose is one link: confirm the address, reset the password, join a team,
 * reconnect an account or open a post.
 */
export function ActionEmail(props: { locale: Locale; url: string; text: ActionEmailText }): ReactNode {
  const { text } = props;
  return (
    <EmailLayout locale={props.locale} title={text.subject} preview={text.preview} footer={text.footer}>
      <Paragraph>{text.greeting}</Paragraph>
      {text.intro.map((paragraph) => (
        <Paragraph key={paragraph}>{paragraph}</Paragraph>
      ))}
      <ActionButton href={props.url}>{text.action}</ActionButton>
      <LinkFallback label={text.linkFallback} href={props.url} />
      {text.notes.map((paragraph) => (
        <Paragraph key={paragraph}>{paragraph}</Paragraph>
      ))}
    </EmailLayout>
  );
}
