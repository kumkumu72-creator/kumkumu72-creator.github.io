import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateROI, parseNumericInput } from '../assets/site/roi-calculator.mjs';

const baseline = { N: 100, T: 2, p: 25, H: 2000, S: 20000, I: 120000, R: 0, C: 0, travelEnabled: false };

test('согласованный контрольный пример', () => {
  const { state, results } = calculateROI(baseline);
  assert.equal(state, 'calculated');
  assert.equal(results.savedHoursMonthly, 50);
  assert.equal(results.laborValueMonthly, 100000);
  assert.equal(results.grossBenefitMonthly, 100000);
  assert.equal(results.netBenefitMonthly, 80000);
  assert.equal(results.totalCost12Months, 360000);
  assert.equal(results.netBenefit12Months, 840000);
  assert.ok(Math.abs(results.roi12MonthsPct - 233.33333333333334) < 1e-10);
  assert.equal(results.paybackMonths, 1.5);
});

test('пустое значение отличается от явно введённого нуля', () => {
  assert.equal(calculateROI().state, 'empty');
  for (const field of ['N', 'T', 'p', 'H', 'S', 'I']) {
    const result = calculateROI({ ...baseline, [field]: '  ' });
    assert.equal(result.state, 'empty');
    assert.equal(result.results, null);
  }
  assert.equal(calculateROI({ ...baseline, I: '0' }).state, 'calculated');
});

test('отрицательный эффект сохраняется, неокупаемость имеет null срок', () => {
  const { results } = calculateROI({ ...baseline, p: 0 });
  assert.equal(results.netBenefit12Months, -360000);
  assert.equal(results.netBenefitMonthly, -20000);
  assert.equal(results.roi12MonthsPct, -100);
  assert.equal(results.paybackMonths, null);
});

test('нулевые затраты, нулевой месячный эффект и отсутствие разовых вложений', () => {
  const noCosts = calculateROI({ ...baseline, I: 0, S: 0 }).results;
  assert.equal(noCosts.totalCost12Months, 0);
  assert.equal(noCosts.roi12MonthsPct, null);
  assert.equal(noCosts.paybackMonths, null);
  const noMonthlyBenefit = calculateROI({ ...baseline, S: 100000 }).results;
  assert.equal(noMonthlyBenefit.netBenefitMonthly, 0);
  assert.equal(noMonthlyBenefit.paybackMonths, null);
  assert.equal(calculateROI({ ...baseline, I: 0 }).results.paybackMonths, null);
});

test('некорректные значения не дают результатов', () => {
  for (const update of [{ p: -1 }, { p: 101 }, { N: 1.5 }, { T: -1 }, { H: 'NaN' }, { S: Infinity }, { I: '1e4' }, { N: Number.MAX_SAFE_INTEGER + 1 }, { T: false }]) {
    const result = calculateROI({ ...baseline, ...update });
    assert.equal(result.state, 'invalid', JSON.stringify(update));
    assert.equal(result.results, null);
  }
  assert.equal(calculateROI({ ...baseline, T: 1e308 }).state, 'invalid');
});

test('привычная десятичная запятая и разделители групп цифр', () => {
  assert.equal(parseNumericInput(' 2 000,50 '), 2000.5);
  assert.equal(parseNumericInput('2\u00a0000,50'), 2000.5);
  assert.equal(parseNumericInput('2\u202f000.50'), 2000.5);
  assert.equal(parseNumericInput(',5'), .5);
  assert.ok(Number.isNaN(parseNumericInput('2,000,50')));
  assert.ok(Number.isNaN(parseNumericInput('1 000 ₽')));
  const { state, results } = calculateROI({ ...baseline, T: '2,25', H: '2 000,50' });
  assert.equal(state, 'calculated');
  assert.equal(results.savedHoursMonthly, 56.25);
  assert.equal(results.laborValueMonthly, 112528.125);
});

test('выезды добавляют только прямые нетрудовые расходы и отключены по умолчанию', () => {
  const ignored = calculateROI({ ...baseline, R: 101, C: 5000 });
  assert.equal(ignored.state, 'calculated');
  assert.equal(ignored.inputs.R, 0);
  assert.equal(ignored.inputs.C, 0);
  assert.equal(ignored.results.travelSavingsMonthly, 0);
  const enabled = calculateROI({ ...baseline, travelEnabled: true, R: 10, C: 5000 }).results;
  assert.equal(enabled.savedHoursMonthly, 50);
  assert.equal(enabled.laborValueMonthly, 100000);
  assert.equal(enabled.travelSavingsMonthly, 50000);
  assert.equal(enabled.grossBenefitMonthly, 150000);
  assert.equal(enabled.netBenefit12Months, 1440000);
  for (const R of [101, 1.5, -1]) {
    assert.equal(calculateROI({ ...baseline, travelEnabled: true, R, C: 1000 }).state, 'invalid');
  }
  assert.equal(calculateROI({ ...baseline, travelEnabled: true, R: '', C: '' }).state, 'empty');
});

test('пересчёт независим, не изменяет исходные данные, срок может быть больше года', () => {
  const raw = Object.freeze({ ...baseline });
  assert.equal(calculateROI(raw).results.netBenefit12Months, 840000);
  const changed = calculateROI({ ...raw, I: 2000000 });
  assert.equal(changed.results.paybackMonths, 25);
  assert.equal(changed.results.netBenefit12Months, -1040000);
  assert.equal(calculateROI({ ...raw, S: '' }).results, null);
  assert.equal(calculateROI(raw).results.netBenefit12Months, 840000);
});
