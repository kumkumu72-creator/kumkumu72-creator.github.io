const screens = [
  {
    title: 'Начать с конкретного аппарата',
    description: 'Модель, серийный номер, конфигурация, версия ПО и история обслуживания задают контекст для работы.',
    heading: 'Карточка оборудования · DEMO‑035',
    rows: [['Аппарат', 'Mindray WATO EX‑35'], ['Конфигурация и ПО', 'Фиксируются при идентификации'], ['История', 'Сервисные случаи, работы и документы']],
    note: 'История относится к конкретному аппарату, а не только к модели.'
  },
  {
    title: 'Вести диагностику в сервисном случае',
    description: 'Инженер записывает симптомы и наблюдения, обращается к источникам и выбирает применимый сценарий. ИИ помогает искать, а решение принимает человек.',
    heading: 'Сервисный случай · DEMO‑001',
    rows: [['Контекст', 'Оборудование DEMO‑035'], ['Материалы', 'Документы с источниками и похожие случаи'], ['Работа инженера', 'Диагностика → сценарий → действия']],
    note: 'Обзор возможностей. Технические действия здесь не воспроизводятся.'
  },
  {
    title: 'Зафиксировать работу и результат',
    description: 'Выполненные действия, измерения, заменённые компоненты и результат остаются в истории аппарата. После закрытия можно подготовить кандидата в решение.',
    heading: 'Результат сервисного случая',
    rows: [['В истории', 'Действия, документы и результат'], ['Сервисный случай', 'Закрыт инженером'], ['Кандидат в решение', 'Ожидает экспертной проверки']],
    note: 'Закрытый случай ещё не означает, что решение проверено.'
  },
  {
    title: 'Подтвердить решение отдельно',
    description: 'Уполномоченный эксперт проверяет источники и применимость. Только после отдельного подтверждения версия решения может быть опубликована в базе знаний.',
    heading: 'Проверенное решение · пример карточки',
    rows: [['Статус примера', 'Кандидат · не опубликован'], ['Проверка эксперта', 'Источники, обоснование, область применимости'], ['После подтверждения', 'Версия и управляемая публикация']],
    note: 'Verified Solution используется повторно в подходящем контексте.'
  }
];

let activeScreen = 0;
const tabs = [...document.querySelectorAll('[data-overview]')];
const previous = document.querySelector('#general-prev-step');
const next = document.querySelector('#general-next-step');
function renderOverview(index) {
  activeScreen = index;
  const screen = screens[index];
  tabs.forEach((tab, tabIndex) => {
    tab.setAttribute('aria-selected', String(index === tabIndex));
    tab.tabIndex = index === tabIndex ? 0 : -1;
  });
  document.querySelector('#overview-panel').setAttribute('aria-labelledby', tabs[index].id);
  document.querySelector('#overview-count').textContent = `Экран ${index + 1} из ${screens.length}`;
  document.querySelector('#overview-title').textContent = screen.title;
  document.querySelector('#overview-description').textContent = screen.description;
  // All overview content is static, synthetic presentation data owned by this page.
  document.querySelector('#overview-screen').innerHTML = `<span class="preview-caption">MESTARO Assist · рабочее место инженера</span><h4>${screen.heading}</h4><dl>${screen.rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl><p class="screen-note">${screen.note}</p>`;
  previous.disabled = index === 0;
  next.textContent = index === screens.length - 1 ? 'К началу ↺' : 'Далее →';
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => renderOverview(index));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const newIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    renderOverview(newIndex);
    tabs[newIndex].focus();
  });
});
previous.addEventListener('click', () => renderOverview(Math.max(0, activeScreen - 1)));
next.addEventListener('click', () => renderOverview((activeScreen + 1) % screens.length));
renderOverview(0);

// Прежние якоря раскрывают соответствующее пояснение без загрузки 3D.
function revealAnchorDetails() {
  const target = document.getElementById(window.location.hash.slice(1));
  if (!target) return;
  let disclosure = target.closest('details');
  while (disclosure) {
    disclosure.open = true;
    disclosure = disclosure.parentElement.closest('details');
  }
}
window.addEventListener('hashchange', revealAnchorDetails);
revealAnchorDetails();
