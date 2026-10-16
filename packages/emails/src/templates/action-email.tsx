import type { Locale } from '@smp/contracts';
import type { ReactNode } from 'react';

import { ActionButton, EmailLayout, LinkFallback, Paragraph } from '../components/layout';
import { format, messages, type EmailMessages } from '../messages';

/** An email whose purpose is one link: confirm the address, reset the password. */
export function ActionEmail(props: {
  locale: Locale;
  kind: 'verifyEmail' | 'resetPassword';
  name: string | undefined;
  url: string;
}): ReactNode {
  const { common } = messages[props.locale];
  const text: EmailMessages['verifyEmail'] = messages[props.locale][props.kind];
  const greeting = props.name ? format(common.greeting, { name: props.name }) : common.greetingWithoutName;
  return (
    <EmailLayout locale={props.locale} title={text.subject} preview={text.preview} footer={common.footer}>
      <Paragraph>{greeting}</Paragraph>
      <Paragraph>{text.intro}</Paragraph>
      <ActionButton href={props.url}>{text.action}</ActionButton>
      <LinkFallback label={common.linkFallback} href={props.url} />
      <Paragraph>{text.expiry}</Paragraph>
      <Paragraph>{text.ignore}</Paragraph>
    </EmailLayout>
  );
}
