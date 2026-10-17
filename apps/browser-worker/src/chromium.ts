import { chromium, type Browser } from 'playwright';

// Chromium as Playwright starts it, headless and with Playwright's own arguments only (guide
// step 6.2). The proxy is the egress proxy of the network; executablePath a preinstalled
// Chromium outside the image of Playwright, for example in development and CI.
export const launchChromium = (options: {
  executablePath?: string | undefined;
  proxy?: string | undefined;
}): Promise<Browser> =>
  chromium.launch({
    headless: true,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.proxy ? { proxy: { server: options.proxy } } : {}),
  });
