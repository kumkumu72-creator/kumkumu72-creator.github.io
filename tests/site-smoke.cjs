// Запуск: PLAYWRIGHT_MODULE_PATH=<путь к playwright> node tests/site-smoke.cjs
// Только локальная проверка; открытие почтового приложения перехватывается.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const baseUrl = process.env.SITE_URL || 'http://localhost:8000/';
const browserPath = process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outputDir = path.resolve(__dirname, '../tmp/site-update/screenshots');
const results = [];
const errors = [];
const requests = [];
const viewports = [[1440, 900], [1366, 768], [1024, 768], [768, 1024], [390, 844], [360, 800]];
const example = { N: '100', T: '2', p: '25', H: '2 000', S: '20 000', I: '120 000' };

async function check(name, callback) {
  try {
    const detail = await callback();
    results.push({ name, status: 'passed', ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function trackPage(page, label) {
  page.on('pageerror', (error) => errors.push({ label, type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ label, type: 'console', message: message.text() });
  });
  page.on('request', (request) => requests.push({ label, url: request.url(), method: request.method() }));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push({ label, type: 'http', message: `${response.status()} ${response.url()}` });
  });
}

async function assertNoOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    offenders: [...document.querySelectorAll('main *')].filter((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width && style.visibility !== 'hidden' && box.right > innerWidth + 2;
    }).slice(0, 8).map((element) => `${element.tagName}.${element.className}#${element.id}`)
  }));
  assert.ok(dimensions.document <= dimensions.viewport + 2 && dimensions.body <= dimensions.viewport + 2,
    `Горизонтальное переполнение: ${JSON.stringify(dimensions)}`);
}

async function fillRoi(page, values = example) {
  for (const [name, value] of Object.entries(values)) {
    await page.locator(`#roi-form [name="${name}"]`).fill(value);
  }
  const calculate = page.locator('#roi-form button[type="submit"]');
  if (await calculate.count()) await calculate.click();
  await page.waitForFunction(() => window.MestaroROI?.getAttachment());
}

async function attachment(page) {
  return page.evaluate(() => window.MestaroROI?.getAttachment() || null);
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: process.env.HEADED !== '1',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  try {
    for (const [width, height] of viewports) {
      await check(`Макет ${width}×${height}, якоря и отложенная 3D-загрузка`, async () => {
        const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const label = `${width}x${height}`;
        trackPage(page, label);
        try {
          const response = await page.goto(baseUrl, { waitUntil: 'networkidle' });
          assert.equal(response.status(), 200);
          await assertNoOverflow(page);
          assert.equal(await page.locator('#wato-model').getAttribute('src'), null);
          assert.equal(requests.filter((item) => item.label === label && /\.glb(?:[?#]|$)/i.test(item.url)).length, 0);
          assert.equal(await page.locator('#technical-demo').evaluate(element => element.tagName === 'DETAILS'), false, 'Технический сценарий нельзя свернуть');
          assert.equal(await page.locator('#demo-launch').isVisible(), true, 'Блок технического сценария всегда виден');
          assert.equal(await attachment(page), null, 'Пустой калькулятор не должен выдавать результат');
          assert.equal(await page.locator('#contact-attach-roi').isChecked(), false);
          const missingAnchors = await page.locator('a[href^="#"]').evaluateAll((links) => links
            .map((link) => link.getAttribute('href')).filter((href) => href !== '#' && !document.getElementById(decodeURIComponent(href.slice(1)))));
          assert.deepEqual(missingAnchors, []);
          assert.deepEqual(await page.locator('main > section').evaluateAll(sections => sections.map(section => section.id)),
            ['top', 'roi', 'capabilities', 'demo', 'about'], 'Порядок: продукт, окупаемость, подписка, демо');
          assert.equal((await page.locator('h1').textContent()).trim(), 'MESTARO Assist');
          assert.equal(await page.locator('.product-preview').count(), 0, 'На первом экране нет условного интерфейса');
          if (width >= 1366) {
            const cta = page.locator('.hero-actions .primary-action');
            const box = await cta.boundingBox();
            assert.ok(box && box.y >= 0 && box.y + box.height <= height, 'Главная кнопка должна быть видна без прокрутки');
          }
          await page.screenshot({ path: path.join(outputDir, `hero-${label}.png`) });
          if (width <= 390) {
            const toggle = page.locator('#nav-toggle');
            await toggle.focus();
            await page.keyboard.press('Enter');
            assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
            await page.locator('#nav-links').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#nav-links').isVisible(), true);
            await page.keyboard.press('Escape');
            assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
            assert.equal(await toggle.evaluate((element) => element === document.activeElement), true);
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.matches(':focus-visible')), true);
          }
          await page.locator('a[href="#roi"]').first().evaluate((element) => element.click());
          await page.locator('#roi').scrollIntoViewIfNeeded();
          await assertNoOverflow(page);
          await fillRoi(page);
          await assertNoOverflow(page);
          if (width === 1440 || width === 390) {
            await page.locator('#roi').screenshot({ path: path.join(outputDir, `roi-contact-${label}.png`), style: '.site-header, .skip-link { visibility: hidden !important; }' });
          }
          await page.locator('a[href="#contact"]').first().evaluate((element) => element.click());
          assert.equal(new URL(page.url()).hash, '#contact');
          await page.locator('#contact-name').focus();
          assert.equal(await page.locator('#contact-name').evaluate((element) => element === document.activeElement), true);
        } finally {
          await context.close();
        }
      });
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    trackPage(page, 'interaction');
    // Подменяется только внешнее открытие письма; адресат и формирование текста остаются настоящими.
    await page.route('**/assets/site/contact.js*', async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      assert.ok(source.includes('window.location.href = mailto;'), 'Обновите mailto-перехват после изменения реализации');
      await route.fulfill({ response, body: source.replace('window.location.href = mailto;', 'window.__testMailto = mailto;') });
    });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    await check('Обзор: вперёд и назад с клавиатуры', async () => {
      const initial = await page.locator('#overview-title').textContent();
      await page.locator('#general-next-step').focus();
      await page.keyboard.press('Enter');
      assert.notEqual(await page.locator('#overview-title').textContent(), initial);
      await page.locator('#general-prev-step').click();
      assert.equal(await page.locator('#overview-title').textContent(), initial);
    });

    await check('Контакт без ROI; открытие письма перехвачено', async () => {
      const submit = page.locator('#contact-submit');
      if (await submit.isDisabled()) return 'Публичный канал не настроен; отправка честно отключена.';
      await submit.click();
      assert.equal(await page.locator('#contact-name').getAttribute('aria-invalid'), 'true');
      await page.locator('#contact-name').fill('Тестовый инженер');
      await page.locator('#contact-company').fill('Синтетическая тестовая компания');
      await page.locator('#contact-reply').fill('qa@example.invalid');
      await page.locator('#contact-task').fill('Локальная проверка интерфейса. Письмо не отправляется.');
      await submit.click();
      const mailto = await page.evaluate(() => window.__testMailto);
      assert.ok(mailto?.startsWith('mailto:'));
      const body = new URL(mailto).searchParams.get('body');
      assert.ok(body.includes('qa@example.invalid'));
      assert.ok(!body.includes('Расчёт ROI'));
    });

    await check('ROI: расчёт, явное приложение и сброс устаревшего результата', async () => {
      await fillRoi(page);
      const current = await attachment(page);
      assert.equal(current.horizonMonths, 12);
      assert.equal(current.currency, 'RUB');
      assert.ok(current.formulaVersion);
      assert.equal(current.results.savedHoursMonthly, 50);
      assert.equal(current.results.grossBenefitMonthly, 100000);
      assert.equal(current.results.netBenefit12Months, 840000);
      assert.ok(Math.abs(current.results.roi12MonthsPct - 233.33333333333334) < 1e-9);
      assert.equal(current.results.paybackMonths, 1.5);
      assert.equal(await page.locator('#contact-attach-roi').isChecked(), false);
      await page.locator('#contact-attach-roi').check();
      assert.equal(await page.locator('#contact-roi-preview').isVisible(), true);
      assert.equal(await page.locator('#contact-roi-text').textContent(), current.summary);
      if (await page.locator('#contact-submit').isEnabled()) {
        await page.locator('#contact-submit').click();
        const mailto = await page.evaluate(() => window.__testMailto);
        assert.ok(new URL(mailto).searchParams.get('body').includes(current.summary));
      }
      await page.locator('#roi-form [name="N"]').fill('');
      assert.equal(await attachment(page), null);
      assert.equal(await page.locator('#contact-attach-roi').isChecked(), false);
      assert.equal(await page.locator('#contact-roi-preview').isVisible(), false);
      await page.locator('#roi-form [name="N"]').fill('100');
      await page.locator('#roi-form [name="p"]').fill('101');
      assert.equal(await attachment(page), null);
      await fillRoi(page, { ...example, T: '1,5' });
      assert.equal((await attachment(page)).results.savedHoursMonthly, 37.5);
      await page.locator('#roi-T').fill('0,00125');
      assert.ok((await attachment(page)).summary.includes('0,00125 чел.-ч'), 'Исходные значения в письме сохраняют точность');
      await fillRoi(page);
      assert.equal(await page.evaluate(() => localStorage.length), 0);
      assert.ok(!/[?&](N|T|p|H|S|I)=/.test(page.url()));
      assert.equal(requests.filter((item) => item.method !== 'GET').length, 0, 'Ввод не должен отправлять данные');
    });

    await check('Увеличение текста до 200%', async () => {
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; document.body.style.fontSize = '200%'; });
      try { await assertNoOverflow(page); }
      finally { await page.evaluate(() => { document.documentElement.style.fontSize = ''; document.body.style.fontSize = ''; }); }
    });

    await check('Техническое демо: запуск, обязательная проверка, навигация, ящики', async () => {
      await page.locator('#technical-demo-title').click();
      assert.equal(await page.locator('#demo-launch').isVisible(), true, 'Нажатие заголовка не закрывает сценарий');
      await page.locator('#demo-launch').click();
      await page.waitForFunction(() => document.querySelector('#wato-model')?.loaded, null, { timeout: 90000 });
      await page.waitForFunction(() => document.querySelectorAll('#scenario-actions input').length > 0);
      assert.equal(await page.locator('#next-step').isDisabled(), true);
      const gate = page.locator('#step-gate');
      if (await gate.count()) assert.ok((await gate.textContent()).trim().length > 0);
      await page.getByRole('combobox', { name: 'Комплектация WATO EX-35', exact: true }).selectOption('0619B-PA00228');
      assert.equal(await page.locator('#next-step').isDisabled(), true, 'Выбор комплектации не заменяет подтверждение безопасности');
      await page.locator('#scenario-actions input[type="checkbox"]').first().check();
      assert.equal(await page.locator('#next-step').isEnabled(), true);
      await page.locator('#scenario-actions input[type="checkbox"]').first().uncheck();
      assert.equal(await page.locator('#next-step').isDisabled(), true);
      await page.locator('#scenario-actions input[type="checkbox"]').first().check();
      await page.locator('#next-step').click();
      assert.equal((await page.locator('#step-number').textContent()).trim(), '02');
      await page.locator('#prev-step').click();
      assert.equal((await page.locator('#step-number').textContent()).trim(), '01');
      await page.locator('#focus-model').click();
      assert.equal(await page.locator('#wato-model').getAttribute('auto-rotate'), null, 'Reduced motion отключает автовращение');
      assert.equal(await page.locator('#toggle-rotation').getAttribute('aria-pressed'), 'false');
      for (const number of [1, 2, 3, 4]) {
        const drawer = page.locator(`.drawer-control[data-drawer="${number}"]`);
        await drawer.click();
        assert.equal(await drawer.getAttribute('aria-pressed'), 'true');
        await drawer.click();
        assert.equal(await drawer.getAttribute('aria-pressed'), 'false');
      }
      await page.locator('.model-layout').screenshot({ path: path.join(outputDir, 'technical-demo-desktop.png') });
    });

    await check('Полноэкранный режим', async () => {
      const supported = await page.evaluate(() => document.fullscreenEnabled);
      if (!supported) return 'Fullscreen API недоступен в текущем браузере.';
      await page.locator('#model-fullscreen').click();
      await page.waitForFunction(() => Boolean(document.fullscreenElement));
      await page.locator('#model-fullscreen').click();
      await page.waitForFunction(() => !document.fullscreenElement);
    });

    await check('Мобильные команды вынесены под модель', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await assertNoOverflow(page);
      const model = await page.locator('#wato-model').boundingBox();
      const controls = await page.locator('.model-controls').boundingBox();
      assert.ok(model && controls && controls.y >= model.y + model.height - 2, 'Команды перекрывают canvas модели');
      await page.locator('#model-stage').screenshot({ path: path.join(outputDir, 'technical-demo-mobile.png') });
    });

    await context.close();
    await check('Консоль, сеть и ошибки JavaScript', async () => { assert.deepEqual(errors, []); });
  } finally {
    await browser.close();
    const report = { baseUrl, browserPath, results, errors, screenshots: outputDir };
    await fs.writeFile(path.join(outputDir, '../browser-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: results.filter((item) => item.status === 'passed').length, failed: results.filter((item) => item.status === 'failed').length, screenshots: outputDir }, null, 2));
    if (results.some((item) => item.status === 'failed')) process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
