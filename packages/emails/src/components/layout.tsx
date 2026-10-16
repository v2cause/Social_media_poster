import type { Locale } from '@smp/contracts';
import type { ReactNode } from 'react';

// Plain HTML with inline styles and tables, which every mail client renders. No images, no
// remote resources and no tracking pixels (guide step 1.8).

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function EmailLayout(props: {
  locale: Locale;
  title: string;
  preview: string;
  footer: string;
  children: ReactNode;
}): ReactNode {
  return (
    <html lang={props.locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
      </head>
      <body style={{ margin: 0, padding: 0, backgroundColor: '#f4f4f5', fontFamily: FONT }}>
        <div style={{ display: 'none', maxHeight: 0, overflow: 'hidden' }}>{props.preview}</div>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: '32px 16px' }}>
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{ maxWidth: 560, backgroundColor: '#ffffff', borderRadius: 8 }}
                >
                  <tbody>
                    <tr>
                      <td style={{ padding: 32, color: '#18181b', fontSize: 16, lineHeight: '24px' }}>
                        <p style={{ margin: '0 0 24px', fontSize: 14, fontWeight: 600, color: '#52525b' }}>
                          Social Media Poster
                        </p>
                        {props.children}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p style={{ maxWidth: 560, margin: '16px 0 0', fontSize: 12, color: '#71717a' }}>
                  {props.footer}
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

export function Paragraph(props: { children: ReactNode }): ReactNode {
  return <p style={{ margin: '0 0 16px' }}>{props.children}</p>;
}

export function ActionButton(props: { href: string; children: ReactNode }): ReactNode {
  return (
    <p style={{ margin: '24px 0' }}>
      <a
        href={props.href}
        style={{
          display: 'inline-block',
          padding: '12px 20px',
          backgroundColor: '#18181b',
          color: '#ffffff',
          borderRadius: 6,
          textDecoration: 'none',
          fontWeight: 600,
        }}
      >
        {props.children}
      </a>
    </p>
  );
}

/** The link as text, for clients that block buttons and for the plain-text part. */
export function LinkFallback(props: { label: string; href: string }): ReactNode {
  return (
    <p style={{ margin: '0 0 16px', fontSize: 13, color: '#52525b', wordBreak: 'break-all' }}>
      {props.label} <a href={props.href}>{props.href}</a>
    </p>
  );
}
