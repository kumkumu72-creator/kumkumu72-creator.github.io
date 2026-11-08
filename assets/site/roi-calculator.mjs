export const FORMULA_VERSION = '1.0.0';
export const HORIZON_MONTHS = 12;

const REQUIRED_FIELDS = ['N', 'T', 'p', 'H', 'S', 'I'];

// Empty input is distinct from an explicit zero. Accept Russian decimal and
// thousands separators without relying on the browser's number input locale.
export function parseNumericInput(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const normalized = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// Pure scenario calculation: no DOM, storage, network, or rounding.
export function calculateROI(raw = {}) {
  const travelEnabled = raw.travelEnabled === true;
  const fields = travelEnabled ? [...REQUIRED_FIELDS, 'R', 'C'] : REQUIRED_FIELDS;
  const inputs = { travelEnabled, R: 0, C: 0 };
  const errors = {};
  let hasInvalid = false;
  let hasMissing = false;

  for (const field of fields) {
    const value = parseNumericInput(raw[field]);
    inputs[field] = value;
    if (value === null) {
      errors[field] = 'Укажите значение, в том числе 0, если затрат или эффекта нет.';
      hasMissing = true;
    } else if (!Number.isFinite(value) || value < 0) {
      errors[field] = 'Введите неотрицательное число.';
      hasInvalid = true;
    } else if ((field === 'N' || field === 'R') && !Number.isSafeInteger(value)) {
      errors[field] = 'Введите целое число от 0 до 9 007 199 254 740 991.';
      hasInvalid = true;
    } else if (field === 'p' && value > 100) {
      errors[field] = 'Введите процент от 0 до 100.';
      hasInvalid = true;
    }
  }

  if (travelEnabled && Number.isFinite(inputs.R) && Number.isFinite(inputs.N) && inputs.R > inputs.N) {
    errors.R = 'Повторных выездов не может быть больше первичных случаев.';
    hasInvalid = true;
  }
  if (hasInvalid || hasMissing) {
    return { state: hasInvalid ? 'invalid' : 'empty', inputs, results: null, errors };
  }

  const { N, T, p, H, S, I, R, C } = inputs;
  const savedHoursMonthly = N * T * p / 100;
  const laborValueMonthly = savedHoursMonthly * H;
  const travelSavingsMonthly = R * C;
  const grossBenefitMonthly = laborValueMonthly + travelSavingsMonthly;
  const netBenefitMonthly = grossBenefitMonthly - S;
  const totalCost12Months = I + HORIZON_MONTHS * S;
  const netBenefit12Months = HORIZON_MONTHS * grossBenefitMonthly - totalCost12Months;
  const roi12MonthsPct = totalCost12Months > 0 ? netBenefit12Months / totalCost12Months * 100 : null;
  const paybackMonths = I > 0 && netBenefitMonthly > 0 ? I / netBenefitMonthly : null;
  const results = {
    savedHoursMonthly, laborValueMonthly, travelSavingsMonthly, grossBenefitMonthly,
    netBenefitMonthly, totalCost12Months, netBenefit12Months, roi12MonthsPct, paybackMonths
  };

  if (Object.values(results).some(value => value !== null && !Number.isFinite(value))) {
    return { state: 'invalid', inputs, results: null, errors: { calculation: 'Значения слишком велики для расчёта. Уменьшите исходные числа.' } };
  }
  return { state: 'calculated', inputs, results, errors };
}
