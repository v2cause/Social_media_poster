import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { z } from 'zod';

// Redis and Mailpit with the images of compose.yaml, for integration tests of the apps.

export interface StartedRedis {
  container: StartedTestContainer;
  url: string;
  stop: () => Promise<void>;
}

export async function startRedis(): Promise<StartedRedis> {
  const container = await new GenericContainer('redis:7.4.11-alpine')
    .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  return {
    container,
    url: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`,
    stop: async () => {
      await container.stop();
    },
  };
}

const messageSummary = z.object({
  ID: z.string(),
  To: z.array(z.object({ Address: z.string() })),
  Subject: z.string(),
});
const messageList = z.object({ messages: z.array(messageSummary) });
const messageDetail = z.object({ Subject: z.string(), Text: z.string(), HTML: z.string() });

export type MailpitMessage = z.infer<typeof messageDetail>;

export interface StartedMailpit {
  container: StartedTestContainer;
  smtpUrl: string;
  apiUrl: string;
  /** Waits until a message to the address arrives and returns the newest one. */
  waitForMessage: (to: string, timeoutMs?: number) => Promise<MailpitMessage>;
  stop: () => Promise<void>;
}

export async function startMailpit(): Promise<StartedMailpit> {
  const container = await new GenericContainer('axllent/mailpit:v1.31.6')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();
  const host = container.getHost();
  const apiUrl = `http://${host}:${String(container.getMappedPort(8025))}`;

  const waitForMessage = async (to: string, timeoutMs = 10_000): Promise<MailpitMessage> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await fetch(`${apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
      const { messages } = messageList.parse(await response.json());
      const newest = messages[0];
      if (newest) {
        const detail = await fetch(`${apiUrl}/api/v1/message/${newest.ID}`);
        return messageDetail.parse(await detail.json());
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`No email to ${to} within ${String(timeoutMs)} ms`);
  };

  return {
    container,
    smtpUrl: `smtp://${host}:${String(container.getMappedPort(1025))}`,
    apiUrl,
    waitForMessage,
    stop: async () => {
      await container.stop();
    },
  };
}
