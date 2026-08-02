(() => {
  const buttons = document.querySelectorAll('.lang button');
  const copies = document.querySelectorAll('.language-copy');
  const widget = document.getElementById('steam-update-widget');
  const widgetViewport = document.getElementById('steam-update-widget-viewport');

  const screenshotSources = [
    ['shot-start', '/assets/updates/aircraft-design/aircraft-design-start.webp'],
    ['shot-engine-warning', '/assets/updates/aircraft-design/aircraft-design-warning.webp'],
    ['shot-engine-ready', '/assets/updates/aircraft-design/aircraft-design-ready.webp'],
    ['shot-wings', '/assets/updates/aircraft-design/aircraft-design-wings.webp']
  ];

  function mountScreenshotImages() {
    document.querySelectorAll('.update-shot').forEach(shot => {
      if (shot.querySelector('.update-shot-image')) return;

      const source = screenshotSources.find(([className]) => shot.classList.contains(className));
      if (!source) return;

      const image = document.createElement('img');
      image.className = 'update-shot-image';
      image.src = source[1];
      image.alt = shot.getAttribute('aria-label') || '';
      image.decoding = 'async';
      image.loading = 'lazy';
      shot.appendChild(image);
    });
  }

  function resizeWidget() {
    if (!widget || !widgetViewport) return;
    const scale = Math.min(1, widgetViewport.clientWidth / 646);
    widget.style.transform = `scale(${scale})`;
    widgetViewport.style.height = `${Math.ceil(190 * scale)}px`;
  }

  function setLanguage(language) {
    const lang = language === 'pt' ? 'pt' : 'en';
    document.documentElement.lang = lang === 'pt' ? 'pt-PT' : 'en';
    buttons.forEach(button => button.classList.toggle('active', button.id === lang));
    copies.forEach(copy => { copy.hidden = copy.dataset.lang !== lang; });

    if (widget) {
      const source = lang === 'pt' ? widget.dataset.srcPt : widget.dataset.srcEn;
      const title = lang === 'pt' ? 'Aircraft Tycoon na Steam' : 'Aircraft Tycoon on Steam';
      widget.title = title;
      if (source && widget.src !== source) widget.src = source;
    }

    try { localStorage.setItem('aircraftTycoonWebsiteLanguage', lang); } catch (_) {}
    requestAnimationFrame(resizeWidget);
  }

  mountScreenshotImages();
  buttons.forEach(button => button.addEventListener('click', () => setLanguage(button.id)));

  let initial = 'en';
  try { initial = localStorage.getItem('aircraftTycoonWebsiteLanguage') || 'en'; } catch (_) {}

  setLanguage(initial);
  resizeWidget();

  if ('ResizeObserver' in window && widgetViewport) new ResizeObserver(resizeWidget).observe(widgetViewport);
  else window.addEventListener('resize', resizeWidget);
})();
