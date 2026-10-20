import { test, expect } from './catalog-fixture.mjs';

const dialogs = ['diagnostics', 'details', 'parts', 'midi-text', 'playback-settings'];

for (const id of dialogs) {
  test(id + ': close control stays visible and clickable after scrolling', async ({ page, catalogURL }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(catalogURL);
    await expect(page.locator('#rows tr').first()).toBeVisible();

    // Populate the real dialog without starting audio. Use the real diagnostics
    // renderer for the reported bug and long deterministic text for shared dialogs.
    await page.evaluate(async id => {
      const dialog = document.getElementById(id);
      const body = dialog.querySelector('.detail-header + div');
      const heading = dialog.querySelector('.detail-header h2');
      if (heading) heading.textContent += ' · Long MIDI title / ' + 'VeryLongFileName'.repeat(5);
      if (id === 'diagnostics') {
        const { renderMidiDiagnostics } = await import('/player/diagnostics-view.js');
        renderMidiDiagnostics(body, {
          summary: { substituted: 0, unsupported: 0, partial: 0, bankDependent: 32, unverified: 0 },
          eventsScanned: 1000, complete: true, omitted: 0,
          entries: Array.from({ length: 32 }, (_, index) => ({
            status: 'bankDependent', feature: 'CC67', count: 1,
            message: 'The SoundFont modulator receives this controller. Its audible result depends on the instrument.',
            first: { seconds: index / 1000, track: index + 1, port: 0, channel: index % 16 + 1 },
          })),
          note: 'End of the regression fixture report.',
        });
      } else {
        for (let index = 0; index < 60; index++) {
          const paragraph = document.createElement('p');
          paragraph.textContent = 'Long dialog content, row ' + index + '. '.repeat(10);
          body.append(paragraph);
        }
      }
      dialog.showModal();
    }, id);

    const dialog = page.locator('dialog#' + id);
    const body = dialog.locator('.detail-header + div');
    const close = dialog.locator('.detail-header > button');
    await expect(dialog).toBeVisible();
    await expect(close).toBeInViewport({ ratio: 1 });
    const before = await close.boundingBox();
    const dialogBox = await dialog.boundingBox();
    const bodyBox = await body.boundingBox();
    // Wheel over the visible body, including when a regression makes the body
    // taller than the dialog. Scrolling the ancestor must also reveal the bug.
    const visibleBottom = Math.min(bodyBox.y + bodyBox.height, dialogBox.y + dialogBox.height);
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, (bodyBox.y + visibleBottom) / 2);
    await page.mouse.wheel(0, 100000);
    await expect.poll(() => dialog.evaluate(node =>
      node.scrollTop + node.querySelector('.detail-header + div').scrollTop
    ), { message: 'The wheel must actually scroll the long dialog content' }).toBeGreaterThan(0);

    await expect.poll(() => body.evaluate(node =>
      node.scrollHeight - node.clientHeight - node.scrollTop
    ), { message: 'The body must reach its last row' }).toBeLessThanOrEqual(1);

    // Check geometry BEFORE clicking: locator.click() can scroll an escaped X
    // back into view and otherwise hide the original regression.
    const after = await close.boundingBox();
    expect(Math.abs(after.y - before.y), 'The close control moved vertically while scrolling').toBeLessThanOrEqual(1);
    expect(Math.abs(after.x - before.x), 'The close control moved horizontally while scrolling').toBeLessThanOrEqual(1);
    await expect(close).toBeInViewport({ ratio: 1 });
    expect(await body.evaluate(node => node.scrollTop), 'The dialog body must scroll independently').toBeGreaterThan(0);
    expect(await close.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const modal = button.closest('dialog').getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return rect.left >= modal.left && rect.right <= modal.right &&
        rect.top >= modal.top && rect.bottom <= modal.bottom && button.contains(hit);
    }), 'The X must stay inside the dialog and receive pointer events').toBe(true);

    // A coordinate click cannot auto-scroll the button into view. Exercise the
    // production close handler, not a test-supplied dialog.close().
    await page.mouse.click(after.x + after.width / 2, after.y + after.height / 2);
    await expect(dialog).not.toBeVisible();
    await expect(dialog).not.toHaveAttribute('open', '');
    expect(errors).toEqual([]);
  });
}
