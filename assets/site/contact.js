import { contactConfig } from './contact-config.js';

const form = document.querySelector('#contact-form');

if (form) {
  const status = document.querySelector('#contact-status');
  const channelNotice = document.querySelector('#contact-channel-notice');
  const directLink = document.querySelector('#contact-direct');
  const submit = document.querySelector('#contact-submit');
  const attach = document.querySelector('#contact-attach-roi');
  const attachment = document.querySelector('#contact-roi-preview');
  const attachmentText = document.querySelector('#contact-roi-text');
  const attachmentHint = document.querySelector('#contact-roi-hint');
  const email = contactConfig.email.trim();
  const hasChannel = /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(email);
  const required = ['name', 'company', 'contact'];

  function getAttachment() {
    return window.MestaroROI?.getAttachment() || null;
  }

  function updateAttachment() {
    const current = getAttachment();
    attach.disabled = !current;
    if (!current) {
      attach.checked = false;
      attachmentHint.textContent = 'Для приложения расчёта заполните калькулятор. Обратиться можно и без него.';
    } else {
      attachmentHint.textContent = 'Расчёт добавится в текст письма только по вашему выбору.';
    }
    attachment.hidden = !attach.checked || !current;
    attachmentText.textContent = attach.checked && current ? current.summary : '';
  }

  function setError(input, message) {
    const error = document.querySelector(`#${input.id}-error`);
    input.setAttribute('aria-invalid', String(Boolean(message)));
    if (error) error.textContent = message;
  }

  function validate() {
    let firstInvalid = null;
    for (const name of required) {
      const input = form.elements.namedItem(name);
      const value = input.value.trim();
      let message = value ? '' : 'Заполните это поле.';
      if (name === 'contact' && value) {
        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        const isPhone = /^[+\d\s().-]+$/.test(value) && value.replace(/\D/g, '').length >= 7;
        if (!isEmail && !isPhone) message = 'Укажите email или телефон с кодом города / страны.';
      }
      setError(input, message);
      if (message && !firstInvalid) firstInvalid = input;
    }
    firstInvalid?.focus();
    return !firstInvalid;
  }

  if (hasChannel) {
    channelNotice.textContent = 'Письмо откроется в вашем почтовом приложении. Проверьте его и отправьте самостоятельно.';
    directLink.textContent = email;
    directLink.href = `mailto:${encodeURIComponent(email)}`;
    directLink.hidden = false;
    submit.disabled = false;
    submit.textContent = 'Открыть письмо';
  } else {
    channelNotice.textContent = 'Приём обращений пока недоступен: публичный контакт MESTARO ещё не указан.';
    directLink.hidden = true;
    directLink.removeAttribute('href');
    submit.disabled = true;
    submit.textContent = 'Канал связи пока не подключён';
  }

  form.addEventListener('input', (event) => {
    if (required.includes(event.target.name)) setError(event.target, '');
    status.textContent = '';
  });
  attach.addEventListener('change', updateAttachment);
  document.addEventListener('mestaro:roi-change', updateAttachment);
  updateAttachment();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!hasChannel) {
      status.textContent = 'Приём обращений пока недоступен: публичный контакт MESTARO ещё не указан.';
      return;
    }
    if (!validate()) {
      status.textContent = 'Проверьте отмеченные поля. Расчёт ROI для обращения не требуется.';
      return;
    }
    const value = (name) => form.elements.namedItem(name).value.trim();
    const lines = [
      'Здравствуйте! Хочу обсудить сервисную задачу с MESTARO.',
      '',
      `Имя: ${value('name')}`,
      `Компания: ${value('company')}`,
      `Контакт для ответа: ${value('contact')}`
    ];
    if (value('equipment')) lines.push(`Модель оборудования: ${value('equipment')}`);
    if (value('task')) lines.push('', `Задача: ${value('task')}`);
    const current = getAttachment();
    if (attach.checked && !current) {
      updateAttachment();
      status.textContent = 'Расчёт больше не заполнен корректно и не будет приложен. Нажмите «Открыть письмо», чтобы обратиться без него.';
      return;
    }
    if (attach.checked && current) lines.push('', 'Расчёт ROI, выбранный для приложения:', current.summary);
    const body = lines.join('\n');
    const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(contactConfig.subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
    status.textContent = 'Запрошено открытие почтового приложения. Сайт не отправляет письмо: проверьте и отправьте его самостоятельно. Если приложение не открылось, воспользуйтесь email выше.';
  });
}
