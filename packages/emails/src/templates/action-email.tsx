import type { Locale } from '@smp/contracts';
import type { ReactNode } from 'react';

import { ActionButton, EmailLayout, LinkFallback, Paragraph } from '../components/layout';

export interface ActionEmailText {
  subject: string;
  preview: string;
  greeting: string;
  intro: string;
  action: string;
  linkFallback: string;
  expiry: string;
  ignore: string;
  footer: string;
}

/** An email whose purpose is one link: confirm the address, reset the password, join a team. */
export function ActionEmail(props: { locale: Locale; url: string; text: ActionEmailText }): ReactNode {
  const { text } = props;
  return (
    <EmailLayout locale={props.locale} title={text.subject} preview={text.preview} footer={text.footer}>
      <Paragraph>{text.greeting}</Paragraph>
      <Paragraph>{text.intro}</Paragraph>
      <ActionButton href={props.url}>{text.action}</ActionButton>
      <LinkFallback label={text.linkFallback} href={props.url} />
      <Paragraph>{text.expiry}</Paragraph>
      <Paragraph>{text.ignore}</Paragraph>
    </EmailLayout>
  );
}
