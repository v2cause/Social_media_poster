/** One email, already rendered. Links in it point to APP_URL (guide step 1.8). */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Sends emails. The SMTP adapter lives in @smp/emails. */
export interface MailPort {
  send(message: MailMessage): Promise<void>;
}
