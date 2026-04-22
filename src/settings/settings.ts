/**
 * src/settings/settings.ts
 */

const DEFAULTS = {
  fps:            5,
  quality:        'medium',
  sensitivity:    5,
  autoStart:      false,
  backendEnabled: false,
  backendUrl:     'http://localhost:8000',
  analytics:      false,
  notifyDanger:   true,
  notifyWarning:  false,
};

// ─── Element refs — non-null asserted (elements are guaranteed in settings.html) ──
const $fps            = document.getElementById('fps')             as HTMLSelectElement;
const $quality        = document.getElementById('quality')         as HTMLSelectElement;
const $sensitivity    = document.getElementById('sensitivity')     as HTMLInputElement;
const $sensitivityVal = document.getElementById('sensitivity-val') as HTMLSpanElement;
const $autoStart      = document.getElementById('auto-start')      as HTMLInputElement;
const $backendEnabled = document.getElementById('backend-enabled') as HTMLInputElement;
const $backendUrlRow  = document.getElementById('backend-url-row') as HTMLDivElement;
const $backendUrl     = document.getElementById('backend-url')     as HTMLInputElement;
const $analytics      = document.getElementById('analytics')       as HTMLInputElement;
const $notifyDanger   = document.getElementById('notify-danger')   as HTMLInputElement;
const $notifyWarning  = document.getElementById('notify-warning')  as HTMLInputElement;
const $saveBtn        = document.getElementById('save-btn')        as HTMLButtonElement;
const $toast          = document.getElementById('toast')           as HTMLDivElement;

// ─── Load saved settings → populate UI ────────────────────────────────────────

chrome.storage.sync.get(DEFAULTS, (stored) => {
  $fps.value                  = String(stored['fps']);
  $quality.value              = stored['quality'] as string;
  $sensitivity.value          = String(stored['sensitivity']);
  $sensitivityVal.textContent = String(stored['sensitivity']);
  $autoStart.checked          = stored['autoStart']      as boolean;
  $backendEnabled.checked     = stored['backendEnabled'] as boolean;
  $backendUrl.value           = stored['backendUrl']     as string;
  $analytics.checked          = stored['analytics']      as boolean;
  $notifyDanger.checked       = stored['notifyDanger']   as boolean;
  $notifyWarning.checked      = stored['notifyWarning']  as boolean;

  toggleBackendUrlRow(stored['backendEnabled'] as boolean);
});

// ─── Live UI interactions ──────────────────────────────────────────────────────

$sensitivity.addEventListener('input', () => {
  $sensitivityVal.textContent = $sensitivity.value;
});

$backendEnabled.addEventListener('change', () => {
  toggleBackendUrlRow($backendEnabled.checked);
});

function toggleBackendUrlRow(show: boolean): void {
  $backendUrlRow.style.display = show ? 'flex' : 'none';
}

// ─── Save ──────────────────────────────────────────────────────────────────────

$saveBtn.addEventListener('click', () => {
  if ($backendEnabled.checked) {
    const url = $backendUrl.value.trim();
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      $backendUrl.style.borderColor = '#ef4444';
      $backendUrl.focus();
      showToast('⚠️ Enter a valid backend URL', '#ef4444');
      return;
    }
    $backendUrl.style.borderColor = '#334155';
  }

  const settings = {
    fps:            Number($fps.value),
    quality:        $quality.value,
    sensitivity:    Number($sensitivity.value),
    autoStart:      $autoStart.checked,
    backendEnabled: $backendEnabled.checked,
    backendUrl:     $backendUrl.value.trim() || DEFAULTS.backendUrl,
    analytics:      $analytics.checked,
    notifyDanger:   $notifyDanger.checked,
    notifyWarning:  $notifyWarning.checked,
  };

  chrome.storage.sync.set(settings, () => {
    if (chrome.runtime.lastError) {
      showToast('❌ Save failed', '#ef4444');
      return;
    }
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', data: settings })
      .catch(() => {});
    showToast('✅ Settings saved!', '#10b981');
  });
});

// ─── Toast helper ──────────────────────────────────────────────────────────────

function showToast(message: string, color = '#10b981'): void {
  $toast.textContent      = message;
  $toast.style.background = color;
  $toast.classList.add('show');
  setTimeout(() => $toast.classList.remove('show'), 2200);
}