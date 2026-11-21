// 책 뒷면 바코드(ISBN) 읽기.
// 브라우저가 BarcodeDetector 를 지원하면 그것을(빠름), 아니면 @zxing/browser 로 읽습니다.
// 카메라를 못 쓰는 환경(권한 거부·PC 웹캠 없음·구형 브라우저)에서는 안내만 하고,
// 화면 쪽에서 ISBN 숫자 직접 입력으로 넘어갈 수 있게 합니다.
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { normalizeIsbn } from './isbn.js';

function reasonText(e) {
  const name = e?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '카메라 사용이 허용되지 않았습니다. 브라우저 주소창의 카메라 허용을 켜거나, ISBN 숫자를 직접 입력해 주세요.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '카메라를 찾지 못했습니다. ISBN 숫자를 직접 입력해 주세요.';
  if (name === 'NotReadableError') return '다른 앱이 카메라를 쓰고 있는 것 같습니다. 그 앱을 닫고 다시 해 보시거나 ISBN 숫자를 직접 입력해 주세요.';
  return '카메라를 열지 못했습니다. ISBN 숫자를 직접 입력해 주세요.';
}

/**
 * 카메라로 바코드를 계속 읽습니다.
 * @returns {{stop: () => void}}
 */
export async function startScanner({ video, onCode, onError, onHint }) {
  let stopped = false;
  let stream = null;
  let controls = null;
  let timer = 0;
  let detector = null;
  let fired = false;

  const fire = (raw) => {
    if (fired) return;
    const isbn = normalizeIsbn(raw);
    if (!isbn) return;
    fired = true;
    onCode?.(isbn);
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    try { controls?.stop(); } catch { /* 이미 멈춤 */ }
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* 이미 멈춤 */ }
    if (video) { try { video.srcObject = null; } catch { /* 무시 */ } }
  };

  if (!navigator.mediaDevices?.getUserMedia) {
    onError?.('이 브라우저에서는 카메라를 열 수 없습니다. ISBN 숫자를 직접 입력해 주세요.');
    return { stop };
  }

  // 1) 브라우저 기본 BarcodeDetector (안드로이드 크롬·최신 데스크톱)
  try {
    if ('BarcodeDetector' in window) {
      const supported = await window.BarcodeDetector.getSupportedFormats?.() ?? [];
      const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((f) => supported.includes(f));
      if (want.length) detector = new window.BarcodeDetector({ formats: want });
    }
  } catch { detector = null; }

  if (detector) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      video.muted = true;
      await video.play().catch(() => {});
      onHint?.('책 뒷면 바코드를 네모 안에 맞춰 주세요.');
      const tick = async () => {
        if (stopped) return;
        try {
          const codes = await detector.detect(video);
          for (const c of codes) if (c?.rawValue) fire(c.rawValue);
        } catch { /* 프레임 한 장 실패는 무시 */ }
        if (!stopped) timer = setTimeout(tick, 120);
      };
      tick();
      return { stop };
    } catch (e) {
      onError?.(reasonText(e));
      stop();
      return { stop };
    }
  }

  // 2) ZXing (아이폰 사파리·파이어폭스 등)
  try {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: Math.max(120, 150) });
    video.setAttribute('playsinline', '');
    video.muted = true;
    controls = await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      video,
      (result) => { if (result) fire(result.getText()); },
    );
    onHint?.('책 뒷면 바코드를 네모 안에 맞춰 주세요.');
  } catch (e) {
    onError?.(reasonText(e));
    stop();
  }
  return { stop };
}
