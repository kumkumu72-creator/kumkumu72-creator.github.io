import { calculateROI, FORMULA_VERSION, HORIZON_MONTHS } from './roi-calculator.mjs';

const form = document.querySelector('#roi-form');
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const inputFormat = new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 21 });
const moneyFormat = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const money = value => moneyFormat.format(value);
const number = value => numberFormat.format(value);
let current = null;

function paybackText(inputs, results) {
  if (results.netBenefitMonthly <= 0) return 'При этих параметрах затраты не окупаются';
  if (inputs.I === 0) return 'Разовые вложения отсутствуют';
  return `${number(results.paybackMonths)} мес.`;
}

function attachment() {
  if (current?.state !== 'calculated') return null;
  const { inputs, results } = current;
  const summary = [
    `Сценарная оценка ROI · ${HORIZON_MONTHS} месяцев · RUB · формула ${FORMULA_VERSION}`,
    `Первичные сервисные случаи: ${inputFormat.format(inputs.N)} в месяц`,
    `Трудозатраты на случай: ${inputFormat.format(inputs.T)} чел.-ч`,
    `Предполагаемое сокращение трудозатрат: ${inputFormat.format(inputs.p)} %`,
    `Полная стоимость часа: ${inputFormat.format(inputs.H)} ₽`,
    `Регулярные затраты: ${inputFormat.format(inputs.S)} ₽ в месяц`,
    `Разовые затраты: ${inputFormat.format(inputs.I)} ₽`,
    `Эффект по повторным выездам: ${inputs.travelEnabled ? 'включён' : 'отключён'}`,
    `Предотвращённые повторные выезды: ${inputFormat.format(inputs.R)} в месяц`,
    `Прямые нетрудовые расходы на выезд: ${inputFormat.format(inputs.C)} ₽`,
    `Высвобождаемое время: ${number(results.savedHoursMonthly)} ч/месяц`,
    `Стоимость высвобождённого времени: ${money(results.laborValueMonthly)} в месяц`,
    `Эффект по повторным выездам: ${money(results.travelSavingsMonthly)} в месяц`,
    `Эффект до регулярных затрат: ${money(results.grossBenefitMonthly)} в месяц`,
    `Чистый эффект в месяц: ${money(results.netBenefitMonthly)}`,
    `Все затраты за 12 месяцев: ${money(results.totalCost12Months)}`,
    `Чистый эффект за 12 месяцев: ${money(results.netBenefit12Months)}`,
    results.roi12MonthsPct === null ? 'ROI не рассчитывается: затраты равны нулю' : `Оценочный ROI за 12 месяцев: ${number(results.roi12MonthsPct)} %`,
    `Условная окупаемость: ${paybackText(inputs, results)}`,
    ...(results.paybackMonths > HORIZON_MONTHS ? ['Срок окупаемости выходит за горизонт годового ROI.'] : []),
    'Высвобождённое время не всегда превращается в денежную экономию. Фактический эффект проверяется на пилоте.'
  ].join('\n');
  return { formulaVersion: FORMULA_VERSION, currency: 'RUB', horizonMonths: HORIZON_MONTHS, inputs: { ...inputs }, results: { ...results }, summary };
}

window.MestaroROI = { getAttachment: attachment };

if (form) {
  const status = document.querySelector('#roi-status');
  const resultsPanel = document.querySelector('#roi-results');
  const travelToggle = form.elements.travelEnabled;
  const travelFields = document.querySelector('#roi-travel-fields');
  let submitted = false;

  function update() {
    const travelEnabled = travelToggle.checked;
    travelFields.disabled = !travelEnabled;
    form.elements.R.required = travelEnabled;
    form.elements.C.required = travelEnabled;
    const raw = { travelEnabled };
    for (const field of ['N', 'T', 'p', 'H', 'S', 'I', 'R', 'C']) raw[field] = form.elements[field].value;
    current = calculateROI(raw);
    form.dataset.state = current.state;
    for (const field of ['N', 'T', 'p', 'H', 'S', 'I', 'R', 'C']) {
      const input = form.elements[field];
      const showError = Boolean(current.errors[field]) && (submitted || input.value.trim() !== '');
      input.setAttribute('aria-invalid', String(showError));
      const error = document.querySelector(`#roi-${field}-error`);
      error.textContent = showError ? current.errors[field] : '';
      error.hidden = !showError;
    }

    resultsPanel.hidden = current.state !== 'calculated';
    if (current.state !== 'calculated') {
      resultsPanel.querySelectorAll('[data-roi-result]').forEach(output => { output.textContent = '—'; });
      status.textContent = current.state === 'invalid'
        ? (current.errors.calculation || 'Проверьте выделенные поля. Результат появится после исправления.')
        : 'Заполните все основные поля. Если затрат нет, укажите 0. Контакты для расчёта не нужны.';
    } else {
      const { inputs, results } = current;
      const values = {
        savedHoursMonthly: `${number(results.savedHoursMonthly)} ч/месяц`,
        grossBenefitMonthly: `${money(results.grossBenefitMonthly)}/мес.`,
        netBenefit12Months: money(results.netBenefit12Months),
        roi12MonthsPct: results.roi12MonthsPct === null ? 'ROI не рассчитывается: затраты равны нулю' : `${number(results.roi12MonthsPct)} %`,
        paybackMonths: paybackText(inputs, results),
        laborValueMonthly: money(results.laborValueMonthly),
        travelSavingsMonthly: money(results.travelSavingsMonthly),
        netBenefitMonthly: money(results.netBenefitMonthly),
        totalCost12Months: money(results.totalCost12Months)
      };
      resultsPanel.querySelectorAll('[data-roi-result]').forEach(output => {
        output.textContent = values[output.dataset.roiResult];
      });
      document.querySelector('#roi-payback-horizon').hidden = !(results.paybackMonths > HORIZON_MONTHS);
      document.querySelector('#roi-net-result').classList.toggle('roi-negative', results.netBenefit12Months < 0);
      status.textContent = `Расчёт обновлён. Потенциальный чистый эффект за 12 месяцев: ${money(results.netBenefit12Months)}.`;
    }
    document.dispatchEvent(new CustomEvent('mestaro:roi-change', { detail: { state: current.state } }));
  }

  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('submit', event => {
    event.preventDefault();
    submitted = true;
    update();
    if (current.state !== 'calculated') {
      const invalidInput = form.querySelector('[aria-invalid="true"]');
      const disclosure = invalidInput?.closest('details');
      if (disclosure) disclosure.open = true;
      invalidInput?.focus();
    }
  });
  update();
}
