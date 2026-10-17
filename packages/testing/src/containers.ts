import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { z } from 'zod';

// Redis, Mailpit and the object storage with the images of compose.yaml, for integration tests.

export interface StartedRedis {
  container: StartedTestContainer;
  url: string;
  stop: () => Promise<void>;
}

/** Starts Redis; args are further options of redis-server, for example ACL users. */
export async function startRedis(options: { args?: readonly string[] } = {}): Promise<StartedRedis> {
  const container = await new GenericContainer('redis:7.4.11-alpine')
    .withCommand(['redis-server', '--maxmemory-policy', 'noeviction', ...(options.args ?? [])])
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
  /**
   * The newest email to the address, optionally the newest with this subject. Emails go out
   * through the queue, so an earlier email to the same address may still be the newest one.
   */
  waitForMessage: (to: string, options?: { subject?: string; timeoutMs?: number }) => Promise<MailpitMessage>;
  stop: () => Promise<void>;
}

export async function startMailpit(): Promise<StartedMailpit> {
  const container = await new GenericContainer('axllent/mailpit:v1.31.6')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();
  const host = container.getHost();
  const apiUrl = `http://${host}:${String(container.getMappedPort(8025))}`;

  const waitForMessage: StartedMailpit['waitForMessage'] = async (
    to,
    { subject, timeoutMs = 10_000 } = {},
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await fetch(`${apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
      const { messages } = messageList.parse(await response.json());
      // Mailpit lists the newest message first.
      const newest = messages.find((message) => subject === undefined || message.Subject === subject);
      if (newest) {
        const detail = await fetch(`${apiUrl}/api/v1/message/${newest.ID}`);
        return messageDetail.parse(await detail.json());
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `No email to ${to}${subject === undefined ? '' : ` with subject "${subject}"`} within ${String(timeoutMs)} ms`,
    );
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

export interface StartedObjectStorage {
  container: StartedTestContainer;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  stop: () => Promise<void>;
}

const STORAGE_ACCESS_KEY = 'smp-test-access-key';
const STORAGE_SECRET_KEY = 'smp-test-secret-key';

/** SeaweedFS with its S3 gateway, as in compose.yaml, with a test key pair. No bucket yet. */
export async function startObjectStorage(): Promise<StartedObjectStorage> {
  const config = {
    identities: [
      {
        name: 'smp-test',
        credentials: [{ accessKey: STORAGE_ACCESS_KEY, secretKey: STORAGE_SECRET_KEY }],
        actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
      },
    ],
  };
  const container = await new GenericContainer('chrislusf/seaweedfs:4.48')
    // The services find each other on loopback; the gateway listens on every interface for the
    // mapped port.
    .withCommand([
      'server',
      '-s3',
      '-s3.config=/etc/seaweedfs/s3.json',
      '-dir=/data',
      '-ip=127.0.0.1',
      '-ip.bind=0.0.0.0',
    ])
    .withCopyContentToContainer([{ content: JSON.stringify(config), target: '/etc/seaweedfs/s3.json' }])
    .withExposedPorts(8333)
    // Any answer of the S3 port means the gateway is up; the master status alone is not enough.
    .withWaitStrategy(Wait.forHttp('/', 8333).forStatusCodeMatching(() => true))
    .withStartupTimeout(120_000)
    .start();
  return {
    container,
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(8333))}`,
    region: 'us-east-1',
    accessKeyId: STORAGE_ACCESS_KEY,
    secretAccessKey: STORAGE_SECRET_KEY,
    stop: async () => {
      await container.stop();
    },
  };
}
