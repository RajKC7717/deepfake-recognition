/**
 * settings.ts — Persist and restore user settings via chrome.storage.sync
 */

interface Settings {
  sensitivity:     number;
  fps:             number;
  quality:         'low' | 'medium' | 'high';
  autoStart:       boolean;
  backendEnabled:  boolean;
  backendUrl:      string;
  analytics:       boolean;
  notifyDanger:    boolean;
  notifyWarning:   boolean;
}

const DEFAULTS: Settings = {
  sensitivity:    5,
  fps:            5,
  quality:        'medium',
  autoStart:      false,
  backendEnabled: false,
  backendUrl:     'http://localhost:8000',
  analytics:      false,
  notifyDanger:   true,
  notifyWarning:  false,
};

// ── DOM helpers ────────────────────────────────────────────────────────────────
const $  = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  sensitivity:    $<HTMLInputElement>('sensitivity'),
  sensitivityVal: $<HTMLSpanElement>('sensitivity-val'),
  fps:            $<HTMLSelectElement>('fps'),
  quality:        $<HTMLSelectElement>('quality'),
  autoStart:      $<HTMLInputElement>('auto-start'),
  backendEnabled: $<HTMLInputElement>('backend-enabled'),
  backendUrlRow:  $<HTMLDivElement>('backend-url-row'),
  backendUrl:     $<HTMLInputElement>('backend-url'),
  analytics:      $<HTMLInputElement>('analytics'),
  notifyDanger:   $<HTMLInputElement>('notify-danger'),
  notifyWarning:  $<HTMLInputElement>('notify-warning'),
  saveBtn:        $<HTMLButtonElement>('save-btn'),
  toast:          $<HTMLDivElement>('toast'),
};

// ── Load ──────────────────────────────────────────────────────────────────────
chrome.storage.sync.get(DEFAULTS, (stored: Settings) => {
  el.sensitivity.value  = stored.sensitivity.toString();
  el.sensitivityVal.textContent = stored.sensitivity.toString();
  el.fps.value          = stored.fps.toString();
  el.quality.value      = stored.quality;
  el.autoStart.checked  = stored.autoStart;
  el.backendEnabled.checked = stored.backendEnabled;
  el.backendUrl.value   = stored.backendUrl;
  el.analytics.checked  = stored.analytics;
  el.notifyDanger.checked  = stored.notifyDanger;
  el.notifyWarning.checked = stored.notifyWarning;

  // Show/hide backend URL field
  el.backendUrlRow.style.display = stored.backendEnabled ? 'flex' : 'none';
});

// ── Reactive live updates ──────────────────────────────────────────────────────
el.sensitivity.addEventListener('input', () => {
  el.sensitivityVal.textContent = el.sensitivity.value;
});

el.backendEnabled.addEventListener('change', () => {
  el.backendUrlRow.style.display = el.backendEnabled.checked ? 'flex' : 'none';
});

// ── Save ──────────────────────────────────────────────────────────────────────
el.saveBtn.addEventListener('click', () => {
  const settings: Settings = {
    sensitivity:    parseInt(el.sensitivity.value, 10),
    fps:            parseInt(el.fps.value, 10),
    quality:        el.quality.value as Settings['quality'],
    autoStart:      el.autoStart.checked,
    backendEnabled: el.backendEnabled.checked,
    backendUrl:     el.backendUrl.value.trim().replace(/\/$/, ''),
    analytics:      el.analytics.checked,
    notifyDanger:   el.notifyDanger.checked,
    notifyWarning:  el.notifyWarning.checked,
  };

  chrome.storage.sync.set(settings, () => {
    // Notify background of setting changes
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', data: settings }).catch(() => {});
    showToast();
  });
});

function showToast() {
  el.toast.classList.add('show');
  setTimeout(() => el.toast.classList.remove('show'), 2500);
}