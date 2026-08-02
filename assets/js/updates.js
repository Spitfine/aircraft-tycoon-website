(() => {
  const buttons = document.querySelectorAll('.lang button');
  const copies = document.querySelectorAll('.language-copy');

  function setLanguage(language) {
    const lang = language === 'pt' ? 'pt' : 'en';
    document.documentElement.lang = lang === 'pt' ? 'pt-PT' : 'en';
    buttons.forEach(button => button.classList.toggle('active', button.id === lang));
    copies.forEach(copy => {
      copy.hidden = copy.dataset.lang !== lang;
    });
    try { localStorage.setItem('aircraftTycoonWebsiteLanguage', lang); } catch (_) {}
  }

  buttons.forEach(button => button.addEventListener('click', () => setLanguage(button.id)));
  let initial = 'en';
  try { initial = localStorage.getItem('aircraftTycoonWebsiteLanguage') || 'en'; } catch (_) {}
  setLanguage(initial);
})();
