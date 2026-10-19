import { expect, test, type Locator, type Page, type Response } from '@playwright/test';

import { signUpOwner } from './accounts';
import { expectAccessible } from './axe';

// Guide step 3.6, "Fertig, wenn": upload, crop, attach and the preview with the image. The worker
// runs the role media against the local object storage; the API runs with AI_PROVIDER=mock, whose
// alt text is deterministic.

const run = Date.now().toString(36);
const owner = {
  name: 'Mira Medien',
  email: `media-${run}@example.test`,
  password: 'media password 2026',
};

const FILE = 'buero-panorama.jpg';
const BRIEF = 'Unser neues Büro in Köln';
const ALT_TEXT = `Eine ruhige, klar aufgebaute Szene zum Thema ${BRIEF}.`;

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Hauptnavigation' });

/** A panorama of 2400 x 1000 pixels, wider than Instagram takes, drawn as a JPEG in the browser. */
async function panorama(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1000;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('No 2D context.');
    }
    const sky = context.createLinearGradient(0, 0, 0, 1000);
    sky.addColorStop(0, '#1e3a8a');
    sky.addColorStop(1, '#f59e0b');
    context.fillStyle = sky;
    context.fillRect(0, 0, 2400, 1000);
    context.fillStyle = '#fde68a';
    context.beginPath();
    context.arc(1200, 560, 180, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#14532d';
    context.fillRect(0, 750, 2400, 250);
    return canvas.toDataURL('image/jpeg', 0.9);
  });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/** The width of the loaded image; 0 while it loads or when the browser could not load it. */
const loadedWidth = (image: Locator): Promise<number> =>
  image.evaluate((element: HTMLImageElement) => (element.complete ? element.naturalWidth : 0));

interface SavedMedia {
  items?: { crop?: { width: number; height: number } | null; altText?: string | null }[];
}

/** The auto-save of the Instagram media: one image, cropped square, with the suggested alt text. */
const savesCroppedImage = (response: Response): boolean => {
  const request = response.request();
  if (request.method() !== 'PUT' || !/\/variants\/[0-9a-f-]{36}\/media$/.test(request.url())) {
    return false;
  }
  const { items } = request.postDataJSON() as SavedMedia;
  const crop = items?.[0]?.crop;
  return (
    response.ok() &&
    items?.length === 1 &&
    crop !== undefined &&
    crop !== null &&
    crop.width === crop.height &&
    items[0]?.altText === ALT_TEXT
  );
};

test('upload an image, attach it to Instagram, crop it and see it in the preview', async ({
  page,
}, testInfo) => {
  await signUpOwner(page, owner, `Medien ${run}`);
  const photo = await panorama(page);

  // Library: the upload goes straight to the object storage, the worker checks it.
  await navigation(page).getByRole('link', { name: 'Medien' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Medien', exact: true })).toBeVisible();
  await page.getByTestId('media-file-input').setInputFiles({
    name: FILE,
    mimeType: 'image/jpeg',
    buffer: photo,
  });
  const card = page.getByTestId('media-card').filter({ hasText: FILE });
  await expect(card).toHaveAttribute('data-status', 'READY', { timeout: 60_000 });
  await expect(card).toContainText('2400 x 1000 px');
  await expect(card).toContainText('Nicht verwendet');
  await expect.poll(() => loadedWidth(card.getByRole('img'))).toBeGreaterThan(0);

  // Composer: a post for Instagram, the image from the library.
  await navigation(page).getByRole('link', { name: 'Erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Beitrag erstellen' })).toBeVisible();
  await page.getByLabel('Worum geht es?').fill(BRIEF);
  await page.getByRole('button', { name: 'Instagram', exact: true }).click();
  await page.getByRole('tab', { name: 'Instagram' }).click();
  const media = page.getByTestId('variant-media');
  await media.getByRole('button', { name: 'Medien hinzufügen' }).click();
  const picker = page.getByRole('dialog', { name: 'Medien hinzufügen' });
  await picker.getByRole('button', { name: `${FILE} auswählen` }).click();
  await picker.getByRole('button', { name: '1 Bild hinzufügen' }).click();
  await expect(picker).toBeHidden();
  await expect(media.getByTestId('strip-item')).toHaveCount(1);
  const selected = media.getByTestId('selected-media');
  await expect(selected).toContainText('Bild 1 von 1');
  // 2.4:1 is wider than Instagram takes.
  await expect(selected.getByRole('note')).toContainText('Passt nicht zum Seitenverhältnis');

  // Crop: square instead of the preset 4:5.
  await selected.getByRole('button', { name: 'Zuschneiden' }).click();
  const cropDialog = page.getByRole('dialog', { name: 'Zuschneiden für Instagram' });
  await expect(cropDialog.getByRole('button', { name: 'Hochformat 4:5' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await cropDialog.getByRole('button', { name: 'Quadrat 1:1' }).click();
  const cropper = cropDialog.getByTestId('cropper');
  await expect
    .poll(async () => {
      const box = await cropper.boundingBox();
      return box ? Math.round((box.width / box.height) * 100) / 100 : null;
    })
    .toBe(1);
  // Without dragging (guide step 8.8): the buttons move the image, which is wider than the square.
  const image = cropDialog.getByRole('group', { name: 'Bildausschnitt' }).locator('xpath=..').locator('img');
  const before = await image.getAttribute('style');
  await cropDialog.getByRole('button', { name: 'Bild nach links verschieben' }).click();
  await expect(image).not.toHaveAttribute('style', before ?? '');
  await expectAccessible(page, testInfo, 'crop dialog');
  await cropDialog.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(cropDialog).toBeHidden();
  await expect(selected).toContainText('Zugeschnitten');
  await expect(selected.getByRole('note')).toHaveCount(0);

  // Alt text from the mock AI, about the topic of the post.
  const saved = page.waitForResponse(savesCroppedImage);
  await selected.getByRole('button', { name: 'Vorschlagen' }).click();
  await expect(selected.getByText(ALT_TEXT)).toBeVisible();
  await selected.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(selected.getByLabel('Alt-Text')).toHaveValue(ALT_TEXT);
  await saved;
  await expect(page.getByTestId('save-status')).toContainText('Gespeichert');

  // Preview: the square crop of the loaded thumbnail, described by the alt text.
  const preview = page.getByTestId('preview-images');
  const previewImage = preview.getByRole('img', { name: ALT_TEXT });
  await expect(previewImage).toBeVisible();
  await expect.poll(() => loadedWidth(previewImage)).toBeGreaterThan(0);
  const frame = await previewImage.locator('..').boundingBox();
  expect(frame && Math.round((frame.width / frame.height) * 100) / 100).toBe(1);

  // Reload: image, crop and alt text come back.
  await expect(page).toHaveURL(/\/posts\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Beitrag bearbeiten' })).toBeVisible();
  await page.getByRole('tab', { name: 'Instagram' }).click();
  await expect(media.getByTestId('strip-item')).toHaveCount(1);
  await expect(selected).toContainText('Zugeschnitten');
  await expect(selected.getByLabel('Alt-Text')).toHaveValue(ALT_TEXT);
  await expect(preview.getByRole('img', { name: ALT_TEXT })).toBeVisible();

  // The library counts the use.
  await navigation(page).getByRole('link', { name: 'Medien' }).click();
  await expect(card).toContainText('In 1 Variante verwendet');
});
